import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Client } from '@notionhq/client';
import helmet from 'helmet';
import ratelimit from 'express-rate-limit';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const app = express();

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  notionVersion: "2025-09-03"
});

const DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Khớp chính xác 100% tên các cột trong bảng Notion của bạn
const PROP = {
  name: "Tên ván",
  info: "Thông tin ván",
  stock: "SL Tồn",
  price: "Giá dự kiến",
  gifts: "Gifts",
  status: "Tình trạng hàng",
  manualStatus: "Tình trạng hàng",
  condition: "Loại hàng",
  category: "Danh mục"
};

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(express.json({ limit: "100kb" }));

app.use("/api", ratelimit({
  windowMs: 60 * 1000,
  limit: 120
}));

app.use(express.static(path.join(__dirname, "public")));

// Đọc dữ liệu Property Notion
function readProperty(page, name) {
  const p = page.properties?.[name];
  if (!p) return null;

  switch (p.type) {
    case "title":
      return p.title.map(x => x.plain_text).join("");
    case "rich_text":
      return p.rich_text.map(x => x.plain_text).join("");
    case "number":
      return p.number;
    case "select":
      return p.select?.name || "";
    case "status":
      return p.status?.name || "";
    case "multi_select":
      return p.multi_select.map(x => x.name).join(", ");
    case "checkbox":
      return p.checkbox;
    case "formula":
      return p.formula.string ?? p.formula.number ?? null;
    default:
      return "";
  }
}

// Đọc số lượng tồn
function parseStock(value) {
  if (typeof value === "number") return value;
  if (value == null) return 0;
  const match = String(value).match(/-?\d+/);
  return match ? Number(match[0]) : 0;
}

// Kiểm tra sản phẩm có sẵn để hiển thị không
function isAvailable(page) {
  const statusVal = readProperty(page, PROP.status);
  if (statusVal === "Sold Out") return false;
  
  const stock = parseStock(readProperty(page, PROP.stock));
  return stock > 0;
}

// Lấy danh sách ảnh (Hỗ trợ cả ảnh Cover của trang và ảnh block bên trong)
async function getPageImages(page) {
  const images = [];
  
  // 1. Lấy ảnh Cover nếu có (như trong ảnh bạn vừa chụp)
  if (page.cover) {
    if (page.cover.type === "external") {
      images.push({ url: page.cover.external.url });
    } else if (page.cover.type === "file") {
      images.push({ url: page.cover.file.url });
    }
  }

  // 2. Lấy thêm các ảnh trong nội dung block bên dưới
  try {
    const blocks = await notion.blocks.children.list({ block_id: page.id });
    const blockImages = blocks.results
      .filter(block => block.type === "image")
      .map(block => block.image.file || block.image.external)
      .filter(Boolean);
    
    images.push(...blockImages);
  } catch (err) {
    console.error(`Không thể lấy ảnh blocks của page ${page.id}:`, err.message);
  }

  return images;
}

// Cache dữ liệu
let cache = {
  time: 0,
  products: []
};

const CACHE_TIME = 30 * 1000;

// Lấy dữ liệu sản phẩm từ Notion Database
async function getProducts() {
  if (!DATABASE_ID) {
    console.error("LỖI: Biến môi trường NOTION_DATABASE_ID chưa được thiết lập!");
    return [];
  }

  let pages = [];
  let cursor;

  do {
    const result = await notion.databases.query({
      database_id: DATABASE_ID,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {})
    });

    pages.push(...result.results);
    cursor = result.has_more ? result.next_cursor : undefined;
  } while (cursor);

  const availablePages = pages.filter(isAvailable);
  const productsList = [];

  for (const page of availablePages) {
    const name = readProperty(page, PROP.name) || "Skateboard";
    const info = readProperty(page, PROP.info) || "";
    const stock = parseStock(readProperty(page, PROP.stock));
    const price = Number(readProperty(page, PROP.price) || 0);
    const gifts = readProperty(page, PROP.gifts) || "";
    const condition = readProperty(page, PROP.condition) || "New";
    const category = readProperty(page, PROP.category) || "Complete";

    const images = await getPageImages(page);

    productsList.push({
      id: page.id,
      name,
      info,
      stock,
      price,
      gifts,
      condition,
      category,
      image: images.length > 0 ? `/api/image/${page.id}/0` : null,
      images: images.map((_, index) => `/api/image/${page.id}/${index}`)
    });
  }

  return productsList;
}

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    shop: "Sk82nd"
  });
});

// API sản phẩm
app.get("/api/products", async (req, res) => {
  try {
    if (!process.env.NOTION_TOKEN || !DATABASE_ID) {
      return res.status(500).json({
        success: false,
        error: "Missing Notion configuration"
      });
    }

    if (Date.now() - cache.time > CACHE_TIME) {
      cache.products = await getProducts();
      cache.time = Date.now();
    }

    res.set("Cache-Control", "no-store");
    res.json({
      success: true,
      total: cache.products.length,
      products: cache.products
    });
  } catch (error) {
    console.error("========== SK82ND NOTION ERROR ==========");
    console.error("Message:", error.message);
    console.error("Code:", error.code);
    console.error("Status:", error.status);
    console.error("Body:", error.body);
    console.error("Stack:", error.stack);
    console.error("=========================================");

    res.status(500).json({
      success: false,
      error: "Cannot load Notion inventory"
    });
  }
});

// Lấy URL ảnh từ Notion và chuyển hướng
app.get("/api/image/:pageId/:index", async (req, res) => {
  try {
    const pageId = req.params.pageId;
    const index = Number(req.params.index) || 0;

    // Lấy thông tin trang để lấy cover
    const page = await notion.pages.retrieve({ page_id: pageId });
    const images = await getPageImages(page);
    const image = images[index];

    if (!image || !image.url) {
      return res.sendStatus(404);
    }

    res.set("Cache-Control", "private, max-age=240");
    return res.redirect(image.url);
  } catch (error) {
    console.error("Image error:", error.message);
    return res.sendStatus(404);
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`SK82ND running on port ${PORT}`);
});
