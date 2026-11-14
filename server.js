
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

// Tên Properties trong Database Sk82nd
// Cập nhật lại tên các cột trỏ vào Database Notion mới
const PROP = {
  name: "Tên",
  info: "Thông tin ván",
  stock: "SL Tồn",
  price: "Giá dự kiến",
  gifts: "Gifts",
  status: "Tình trạng hàng (Automate)",
  manualStatus: "Tình trạng hàng (Manual)",
  condition: "Loại hàng (AI)",   // 👈 Cột Formula/AI bóc tách New / 2hand
  category: "Danh mục (AI)"     // 👈 Cột Formula/AI bóc tách Deck, Trucks, v.v.
};

app.use(helmet({
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
      return p.formula.string ??
        p.formula.number ??
        null;

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

const products = [];

// 1. Gọi API lấy dữ liệu từ Notion Database trước
// Khởi tạo mảng sản phẩm trống để tránh lỗi undefined
let products = [];

try {
  const databaseId = process.env.NOTION_DATABASE_ID;
  if (!databaseId) {
    console.error("LỖI: Biến môi trường NOTION_DATABASE_ID chưa được thiết lập trên Render!");
  } else {
    // 1. Truy vấn dữ liệu từ Notion Database an toàn
    const response = await notion.databases.query({
      database_id: databaseId,
    });

    // 2. Vòng lặp `for...of` khai báo đúng biến `page`
    for (const page of response.results) {
      if (!page || !page.id) continue;
      if (!isAvailable(page)) continue;

      let images = [];
      try {
        const blocks = await notion.blocks.children.list({ block_id: page.id });
        images = blocks.results
          .filter(block => block.type === "image")
          .map(block => block.image.file?.url || block.image.external?.url);
      } catch (err) {
        console.error(`Không thể lấy ảnh của page ${page.id}:`, err.message);
      }

      products.push({
        id: page.id,
        name: readProperty(page, PROP.name),
        info: readProperty(page, PROP.info),
        stock: readProperty(page, PROP.stock),
        price: readProperty(page, PROP.price),
        gifts: readProperty(page, PROP.gifts),
        condition: readProperty(page, PROP.condition) || "New",
        category: readProperty(page, PROP.category) || "Complete",
        image: images.length > 0 ? `/api/image/${page.id}/0` : null,
        images: images.map((_, index) => `/api/image/${page.id}/${index}`)
      });
    }
  }
} catch (err) {
  console.error("Lỗi khi kết nối hoặc truy xuất dữ liệu từ Notion:", err.message);
}
// Lấy toàn bộ ảnh trong nội dung trang Notion
// Lấy danh sách block ảnh bên trong trang con của sản phẩm
const blocks = await notion.blocks.children.list({ block_id: page.id });
const images = blocks.results
  .filter(block => block.type === "image")
  .map(block => block.image.file?.url || block.image.external?.url);

products.push({
  id: page.id,
  name: readProperty(page, PROP.name),
  info: readProperty(page, PROP.info),
  stock: readProperty(page, PROP.stock),
  price: readProperty(page, PROP.price),
  gifts: readProperty(page, PROP.gifts),
  condition: readProperty(page, PROP.condition) || "New",
  category: readProperty(page, PROP.category) || "Complete",
  // Ảnh chính cho trang chủ (lấy ảnh đầu tiên)
  image: images.length > 0 ? `/api/image/${page.id}/0` : null,
  // Toàn bộ ảnh cho trang chi tiết
  images: images.map((_, index) => `/api/image/${page.id}/${index}`)
});
// Cache dữ liệu
let cache = {
  time: 0,
  products: []
};

const CACHE_TIME = 30 * 1000;

// Lấy dữ liệu sản phẩm
async function getProducts() {
  let pages = [];
  let cursor;

  do {
    const result = await notion.databases.query({
      database_id: DATABASE_ID,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {})
    });

    pages.push(...result.results);

    cursor = result.has_more
      ? result.next_cursor
      : undefined;

  } while (cursor);

  // Lọc ngay tại Backend
  const availablePages = pages.filter(isAvailable);

  const products = [];

  for (const page of availablePages) {
    const name = readProperty(page, PROP.name) || "Skateboard";

    const info = readProperty(page, PROP.info) || "";

    const stock = parseStock(
      readProperty(page, PROP.stock)
    );

    // Giá website lấy từ Giá dự kiến
    const price = Number(
      readProperty(page, PROP.price) || 0
    );

    const gifts = readProperty(page, PROP.gifts) || "";

    // Ảnh được lấy từ nội dung trang Notion
    const images = await getPageImages(page.id);

    products.push({
      id: page.id,
      name,
      info,
      stock,
      price,
      gifts,
      images: images.map((_, index) =>
        `/api/image/${page.id}/${index}`
      ),
      image: images.length
        ? `/api/image/${page.id}/0`
        : null
    });
  }

  return products;
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

// Lấy URL ảnh mới nhất từ Notion
app.get("/api/image/:pageId/:index", async (req, res) => {
  try {
    const pageId = req.params.pageId;
    const index = Number(req.params.index) || 0;

    const images = await getPageImages(pageId);
    const image = images[index];

    if (!image) {
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
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

app.listen(PORT, () => {
  console.log(`SK82ND running on port ${PORT}`);
});
