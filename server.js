
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

const NOTION_VERSION = "2025-09-03";
const NOTION_URL = "https://api.notion.com/v1";

if (!NOTION_TOKEN || !DATABASE_ID) {
  throw new Error("Missing NOTION_TOKEN or NOTION_DATABASE_ID");
}

async function notionRequest(endpoint, options = {}) {
  const response = await fetch(`${NOTION_URL}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...options.headers
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Notion API ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

// Cache
let cachedProducts = null;
let lastFetch = 0;
const CACHE_DURATION = 30 * 1000;

// Resolve Database ID -> Data Source ID
let dataSourceId = null;

async function getDataSourceId() {
  if (dataSourceId) return dataSourceId;

  const database = await notionRequest(
    `/databases/${DATABASE_ID}`
  );

  const sources = database.data_sources || [];

  if (!sources.length) {
    throw new Error("Database has no accessible data source");
  }

  // Nếu có nhiều data source, chọn theo tên
  const selected =
    sources.find(s => s.name === "Sk82nd") || sources[0];

  dataSourceId = selected.id;

  console.log("Connected to data source:", selected.name);

  return dataSourceId;
}

// Helpers: read Notion property values
function getText(prop) {
  if (!prop) return "";

  if (prop.type === "title" || prop.type === "rich_text") {
    return (prop[prop.type] || [])
      .map(item => item.plain_text)
      .join("");
  }

  if (prop.type === "select" || prop.type === "status") {
    return prop[prop.type]?.name || "";
  }

  if (prop.type === "number") {
    return prop.number ?? "";
  }

  if (prop.type === "url") {
    return prop.url || "";
  }

  if (prop.type === "checkbox") {
    return prop.checkbox;
  }

  if (prop.type === "formula") {
    const value = prop.formula;

    if (value?.type === "string") return value.string;
    if (value?.type === "number") return value.number;

    return "";
  }

  if (prop.type === "rollup") {
    const value = prop.rollup;

    if (value?.type === "number") return value.number;

    return "";
  }

  return "";
}

function getNumber(prop) {
  if (!prop) return null;

  if (prop.type === "number") {
    return prop.number;
  }

  if (prop.type === "formula") {
    return prop.formula?.number ?? null;
  }

  if (prop.type === "rollup") {
    return prop.rollup?.number ?? null;
  }

  const value = getText(prop);

  if (typeof value === "number") return value;

  if (typeof value === "string") {
    const parsed = Number(
      value.replace(/[^\d-]/g, "")
    );

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

// Get image URL from URL, Files & Media or cover
function getImage(prop, page) {
  if (prop?.type === "url" && prop.url) {
    return prop.url;
  }

  if (prop?.type === "files") {
    const file = prop.files?.[0];

    if (file?.type === "external") {
      return file.external.url;
    }

    if (file?.type === "file") {
      return file.file.url;
    }
  }

  if (page.cover?.type === "external") {
    return page.cover.external.url;
  }

  if (page.cover?.type === "file") {
    return page.cover.file.url;
  }

  return null;
}

// Convert Notion page into website product
function mapProduct(page) {
  const p = page.properties || {};

  const name =
    getText(p["Tên"]) ||
    getText(p["Name"]) ||
    "Sk82nd Product";

  const price =
    getNumber(p["Giá bán"]) ??
    getNumber(p["Giá dự kiến"]) ??
    0;

  const description =
    getText(p["Thông tin ván"]) ||
    getText(p["Mô tả"]) ||
    getText(p["Ghi chú"]) ||
    "";

  const category =
    getText(p["Danh mục"]) ||
    getText(p["Sort type"]) ||
    "Skateboard";

  const image =
    getImage(p["Ảnh sản phẩm"], page) ||
    getImage(p["Hình ảnh"], page);

  const stock =
    getNumber(p["SL Stock"]) ??
    getNumber(p["Số lượng tồn"]);

  const status =
    getText(p["Tình trạng hàng (Manual)"]) ||
    getText(p["Tình trạng hàng (Automate)"]);

  // Hỗ trợ database cũ đang lưu "SL: 1"
  const stockText = getText(p["SL Tồn"]);
  const stockMatch = String(stockText).match(/-?\d+/);
  const legacyStock = stockMatch
    ? Number(stockMatch[0])
    : null;

  const quantity = stock ?? legacyStock;

  return {
    id: page.id,
    name,
    price,
    description,
    category,
    image,
    stock: quantity,
    status,
    url: page.url,
    updatedAt: page.last_edited_time
  };
}

// Read all pages with pagination
async function fetchAllProducts() {
  const sourceId = await getDataSourceId();

  let results = [];
  let cursor = undefined;

  do {
    const body = {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {})
    };

    const data = await notionRequest(
      `/data_sources/${sourceId}/query`,
      {
        method: "POST",
        body: JSON.stringify(body)
      }
    );

    results.push(...data.results);

    cursor = data.has_more ? data.next_cursor : null;

  } while (cursor);

  return results;
}

// GET products
app.get("/api/products", async (req, res) => {
  try {
    const now = Date.now();

    if (
      cachedProducts &&
      now - lastFetch < CACHE_DURATION
    ) {
      return res.json({
        success: true,
        cached: true,
        products: cachedProducts
      });
    }

    const pages = await fetchAllProducts();

    let products = pages.map(mapProduct);

    // Remove pages without a name or valid price
    products = products.filter(product =>
      product.name &&
      product.price > 0
    );

    // Hide sold-out products
    products = products.filter(product => {
      const status = String(product.status).toLowerCase();

      if (
        status.includes("đã bán") ||
        status.includes("sold") ||
        status.includes("hết hàng")
      ) {
        return false;
      }

      if (product.stock !== null && product.stock <= 0) {
        return false;
      }

      return true;
    });

    cachedProducts = products;
    lastFetch = now;

    res.json({
      success: true,
      cached: false,
      total: products.length,
      products
    });

  } catch (error) {
    console.error("Product API error:", error.message);

    res.status(500).json({
      success: false,
      message: "Cannot load products from Notion"
    });
  }
});

// GET shop contact information
app.get("/api/config", (req, res) => {
  res.json({
    zalo: process.env.ZALO_PHONE || "",
    messenger: process.env.MESSENGER_PAGE || ""
  });
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    shop: "Sk82nd"
  });
});

app.listen(PORT, () => {
  console.log(`Sk82nd running at http://localhost:${PORT}`);
});
