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

app.set('trust proxy', 1);

const notion = new Client({
  auth: process.env.NOTION_TOKEN?.trim()
});

const DATABASE_ID = "418f5c2fde598066b0b3d4aeebd7128c";

const PROP = {
  name: "Tên ván",
  info: "Thông tin ván",
  stock: "SL Tồn",
  price: "Giá dự kiến",
  gifts: "Gifts",
  status: "Tình trạng hàng",
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
      return p.formula.string ?? p.formula.number ?? p.formula.boolean ?? "";
    case "rollup":
      if (p.rollup.type === "array") {
        return p.rollup.array.map(item => {
          if (item.type === "select") return item.select?.name;
          if (item.type === "rich_text") return item.rich_text.map(x => x.plain_text).join("");
          if (item.type === "formula") return item.formula?.string || item.formula?.number || "";
          return "";
        }).filter(Boolean).join(" ");
      }
      return p.rollup.string ?? p.rollup.number ?? "";
    default:
      return "";
  }
}

function parseStock(value) {
  if (typeof value === "number") return value;
  if (value == null) return 0;
  const match = String(value).match(/-?\d+/);
  return match ? Number(match[0]) : 0;
}

function isAvailable(page) {
  const statusVal = String(readProperty(page, PROP.status) || "").trim();
  if (statusVal.toLowerCase() === "sold out") return false;
  return true;
}

async function getPageImages(page) {
  const images = [];
  if (page.cover) {
    if (page.cover.type === "external") {
      images.push({ url: page.cover.external.url });
    } else if (page.cover.type === "file") {
      images.push({ url: page.cover.file.url });
    }
  }

  try {
    const blocks = await notion.blocks.children.list({ block_id: page.id });
    const blockImages = blocks.results
      .filter(block => block.type === "image")
      .map(block => block.image.file || block.image.external)
      .filter(Boolean);
    images.push(...blockImages);
  } catch (err) {}

  return images;
}

let cache = { time: 0, products: [] };
const CACHE_TIME = 30 * 1000;

async function getProducts() {
  const queryResponse = await notion.databases.query({
    database_id: DATABASE_ID
  });

  const pages = queryResponse.results || [];
  const availablePages = pages.filter(p => p.properties && isAvailable(p));
  const productsList = [];

  for (const page of availablePages) {
    const name = readProperty(page, PROP.name) || "Skateboard";
    
    let rawInfo = readProperty(page, PROP.info) || "";
    const info = rawInfo.replace(/\*THÔNG TIN VÁN\*/gi, "").trim();

    const stock = parseStock(readProperty(page, PROP.stock));
    const price = Number(readProperty(page, PROP.price) || 0);
    const gifts = readProperty(page, PROP.gifts) || "";
    
    // Đọc thêm text từ chính trang Notion (block nội dung hoặc tiêu đề/property khác nếu có)
    let catProp = String(readProperty(page, PROP.category) || "").trim().toLowerCase();
    
    // QUÉT TẤT CẢ DỮ LIỆU THÔ: Nếu tên, thông tin, hoặc bất kỳ chỗ nào chứa từ khóa 2hand/used thì gán luôn là 2hand
    let fullTextSearch = (name + " " + info + " " + catProp).toLowerCase();
    
    let condition = "new";
    if (fullTextSearch.includes("2hand") || fullTextSearch.includes("used") || fullTextSearch.includes("qua su dung") || fullTextSearch.includes("2 hand")) {
      condition = "2hand";
    }

    let category = "complete";
    if (catProp.includes("deck")) category = "deck";
    else if (catProp.includes("truck")) category = "trucks";
    else if (catProp.includes("wheel")) category = "wheels";
    else if (catProp.includes("complete") || fullTextSearch.includes("deck:") && fullTextSearch.includes("trucks:")) {
      category = "complete";
    }

    const images = await getPageImages(page);

    // In log ra để kiểm tra ngay lập tức trên Render
    console.log(`[PARSED PRODUCT] -> Tên: ${name} | Danh mục: ${category} | Loại hàng: ${condition}`);

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

app.get("/api/health", (req, res) => {
  res.json({ status: "OK", shop: "Sk82nd" });
});

app.get("/api/products", async (req, res) => {
  try {
    if (Date.now() - cache.time > CACHE_TIME) {
      cache.products = await getProducts();
      cache.time = Date.now();
    }
    res.set("Cache-Control", "no-store");
    res.json({ success: true, total: cache.products.length, products: cache.products });
  } catch (error) {
    console.error("NOTION ERROR:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/image/:pageId/:index", async (req, res) => {
  try {
    const pageId = req.params.pageId;
    const index = Number(req.params.index) || 0;
    const page = await notion.pages.retrieve({ page_id: pageId });
    const images = await getPageImages(page);
    const image = images[index];
    if (!image || !image.url) return res.sendStatus(404);
    res.set("Cache-Control", "private, max-age=240");
    return res.redirect(image.url);
  } catch (error) {
    return res.sendStatus(404);
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`SK82ND running on port ${PORT}`);
});
