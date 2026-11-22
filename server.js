import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
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

// Database kho hàng (giữ nguyên)
const DATABASE_ID = process.env.NOTION_DATABASE_ID?.trim() || "418f5c2fde598066b0b3d4aeebd7128c";

// Database khách hàng / CRM
const CLIENT_DB_ID = process.env.NOTION_CUSTOMER_DB_ID?.trim() || "415f5c2fde598088884fc6ffc006986e";

// ==========================================
// CHỖ TRỐNG CẤU HÌNH API & LINK (ĐIỀN KHI CÓ)
// ==========================================
const META_PAGE_TOKEN = process.env.META_PAGE_TOKEN?.trim() || ""; // TODO: Điền META_PAGE_TOKEN vào env hoặc thay chuỗi rỗng
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN?.trim() || ""; // TODO: Điền META_VERIFY_TOKEN tự đặt vào env
const META_BUSINESS_ID = process.env.META_BUSINESS_ID?.trim() || "1398185040729817";
const META_PAGE_ID = process.env.META_PAGE_ID?.trim() || "142427568957877";

// TODO: Nếu có link endpoint/webhook TikTok riêng cần gọi hoặc đối chiếu, điền vào đây hoặc qua env TIKTOK_WEBHOOK_URL
const TIKTOK_WEBHOOK_LINK = process.env.TIKTOK_WEBHOOK_URL?.trim() || "";

// OAuth Client ID / App ID (đã điền sẵn ID lấy được, có thể ghi đè bằng biến môi trường trên Render)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim() || "1062826409213-9b31p1jf4klcfa21hgvlkq39t1u84cr5.apps.googleusercontent.com";
const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID?.trim() || "1677171924069694";
const PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET?.trim() || "";

// Thông tin tài khoản nhận thanh toán (kiểm tra và điền tên ngân hàng vào PAYMENT_BANK_NAME / env)
const PAYMENT_BANK_NAME = process.env.PAYMENT_BANK_NAME?.trim() || ""; // TODO: Điền tên ngân hàng của STK 686240799999
const PAYMENT_ACCOUNT_NO = process.env.PAYMENT_ACCOUNT_NO?.trim() || "686240799999";
const PAYMENT_ACCOUNT_NAME = process.env.PAYMENT_ACCOUNT_NAME?.trim() || "NGO TIEN THONG";
// ==========================================

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

const CLIENT_PROP = {
  name: "Tên khách",
  link: "Link khách",
  date: "Ngày nhắn",
  userId: "User ID"
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

    const aiAutofill = readProperty(page, "AI autofill") || "";
    const condProp = readProperty(page, PROP.condition) || "";
    let catProp = String(readProperty(page, PROP.category) || "").trim().toLowerCase();

    let fullTextSearch = (name + " " + info + " " + aiAutofill + " " + condProp + " " + catProp).toLowerCase();

    let condition = "new";
    if (
      fullTextSearch.includes("2hand") ||
      fullTextSearch.includes("2 hand") ||
      fullTextSearch.includes("2nd") ||
      fullTextSearch.includes("used") ||
      fullTextSearch.includes("qua su dung") ||
      fullTextSearch.includes("da qua su dung")
    ) {
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

// ==========================================
// LOGIC GHI KHÁCH HÀNG VÀO NOTION (CRM)
// ==========================================
function getVietnamDateISO(timestampMs = Date.now()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(new Date(timestampMs));
}

function formatPrefixedUserId(platform, rawId) {
  if (!rawId) return "";
  return `${platform}:${String(rawId).trim()}`;
}

async function isDuplicateClientInDay(prefixedUserId, dateISO) {
  if (!prefixedUserId) return false;
  try {
    const res = await notion.databases.query({
      database_id: CLIENT_DB_ID,
      filter: {
        and: [
          {
            property: CLIENT_PROP.userId,
            rich_text: { equals: prefixedUserId }
          },
          {
            property: CLIENT_PROP.date,
            date: { equals: dateISO }
          }
        ]
      },
      page_size: 1
    });
    return (res.results || []).length > 0;
  } catch (err) {
    console.error("CHECK DUPLICATE CLIENT ERROR:", err.message);
    return false;
  }
}

async function createClientRow({ name, link, dateISO, prefixedUserId }) {
  const safeName = (name || prefixedUserId || "Khách hàng").trim();
  const safeLink = (link || "").trim();

  const properties = {
    [CLIENT_PROP.name]: {
      title: [{ text: { content: safeName } }]
    },
    [CLIENT_PROP.date]: {
      date: { start: dateISO }
    },
    [CLIENT_PROP.userId]: {
      rich_text: [{ text: { content: prefixedUserId } }]
    }
  };

  if (safeLink) {
    properties[CLIENT_PROP.link] = {
      rich_text: [
        {
          text: {
            content: safeLink,
            link: safeLink.startsWith("http") ? { url: safeLink } : undefined
          }
        }
      ]
    };
  }

  return notion.pages.create({
    parent: { database_id: CLIENT_DB_ID },
    properties
  });
}

async function fetchMetaProfile(senderId, platform) {
  if (!META_PAGE_TOKEN || !senderId) {
    return { name: senderId, username: "" };
  }
  const fields = platform === "ig" ? "name,username" : "name";
  // TODO: Nếu cần đổi phiên bản Graph API Meta thì sửa v21.0 ở link dưới
  const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(senderId)}?fields=${fields}&access_token=${encodeURIComponent(META_PAGE_TOKEN)}`;

  try {
    const response = await fetch(url);
    if (!response.ok) return { name: senderId, username: "" };
    const data = await response.json();
    return {
      name: data.name || data.username || senderId,
      username: data.username || ""
    };
  } catch (err) {
    console.error("META GRAPH PROFILE ERROR:", err.message);
    return { name: senderId, username: "" };
  }
}

function buildMetaCustomerLink(senderId, platform, username = "") {
  if (platform === "ig" && username) {
    return `https://www.instagram.com/${username}/`;
  }
  // TODO: Điền/kiểm tra lại META_BUSINESS_ID và META_PAGE_ID nếu đổi trang
  return `https://business.facebook.com/latest/inbox/all/?business_id=${META_BUSINESS_ID}&asset_id=${META_PAGE_ID}&selected_item_id=${senderId}`;
}

async function handleIncomingClient({ platform, rawUserId, rawName, rawLink, timestampMs }) {
  const prefixedUserId = formatPrefixedUserId(platform, rawUserId);
  if (!prefixedUserId) return;

  const dateISO = getVietnamDateISO(timestampMs || Date.now());
  const duplicated = await isDuplicateClientInDay(prefixedUserId, dateISO);
  if (duplicated) {
    console.log(`[SKIP DUPLICATE] ${prefixedUserId} on ${dateISO}`);
    return;
  }

  await createClientRow({
    name: rawName,
    link: rawLink,
    dateISO,
    prefixedUserId
  });
  console.log(`[LOGGED CLIENT] ${prefixedUserId} | ${rawName} | ${dateISO}`);
}

// Meta Webhook Verification (GET)
app.get("/webhook/meta", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && META_VERIFY_TOKEN && token === META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Meta Webhook Events (POST)
app.post("/webhook/meta", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body || !Array.isArray(body.entry)) return;

    const platform = body.object === "instagram" ? "ig" : "fb";

    for (const entry of body.entry) {
      const events = entry.messaging || [];
      for (const ev of events) {
        if (!ev.sender?.id || !ev.message || ev.message.is_echo) continue;
        const senderId = String(ev.sender.id);
        const profile = await fetchMetaProfile(senderId, platform);
        const link = buildMetaCustomerLink(senderId, platform, profile.username);

        await handleIncomingClient({
          platform,
          rawUserId: senderId,
          rawName: profile.name,
          rawLink: link,
          timestampMs: ev.timestamp
        });
      }

      const changes = entry.changes || [];
      for (const ch of changes) {
        const val = ch.value;
        if (!val?.sender?.id || !val?.message || val.message.is_echo) continue;
        const senderId = String(val.sender.id);
        const profile = await fetchMetaProfile(senderId, "ig");
        const link = buildMetaCustomerLink(senderId, "ig", profile.username);

        await handleIncomingClient({
          platform: "ig",
          rawUserId: senderId,
          rawName: profile.name,
          rawLink: link,
          timestampMs: val.timestamp ? Number(val.timestamp) * 1000 : Date.now()
        });
      }
    }
  } catch (err) {
    console.error("META WEBHOOK ERROR:", err);
  }
});

// TikTok Webhook Events (POST)
app.post("/webhook/tiktok", async (req, res) => {
  res.sendStatus(200);

  try {
    const payload = req.body || {};
    const data = payload.data || payload;

    // TODO: Chỉnh lại tên trường cho khớp JSON payload thực tế của nguồn webhook TikTok khi có
    const rawUserId =
      data.user_id ||
      data.open_id ||
      data.sender_id ||
      data.customer_id ||
      data.conversation_id ||
      "";

    const rawName =
      data.customer_name ||
      data.sender_name ||
      data.display_name ||
      data.username ||
      rawUserId;

    // TODO: Điền mẫu link fallback TikTok nếu cần (ví dụ link profile/hội thoại)
    const rawLink =
      data.profile_url ||
      data.customer_link ||
      data.link ||
      (data.username ? `https://www.tiktok.com/@${String(data.username).replace(/^@/, "")}` : TIKTOK_WEBHOOK_LINK);

    const ts = data.timestamp || data.created_at || Date.now();
    const timestampMs = typeof ts === "number" && ts < 1e12 ? ts * 1000 : new Date(ts).getTime() || Date.now();

    await handleIncomingClient({
      platform: "tt",
      rawUserId,
      rawName,
      rawLink,
      timestampMs
    });
  } catch (err) {
    console.error("TIKTOK WEBHOOK ERROR:", err);
  }
});

// ==========================================
// LƯU TRỮ TÀI KHOẢN KHÁCH HÀNG TRÊN BACKEND & ĐỒNG BỘ NOTION CRM
// ==========================================
const DATA_DIR = path.join(__dirname, "data");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");

function ensureDataFile(filePath, defaultContent = "[]") {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, defaultContent, "utf8");
  } catch (err) {
    console.error("DATA FILE INIT ERROR:", err.message);
  }
}

function readJsonFile(filePath, fallback) {
  try {
    ensureDataFile(filePath, JSON.stringify(fallback));
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  ensureDataFile(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, originalHash] = storedHash.split(":");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(originalHash, "hex"));
}

async function syncWebAccountToNotionCRM(account) {
  try {
    if (!process.env.NOTION_TOKEN || !CLIENT_DB_ID) return;
    const providerPrefix = account.provider === "Google" ? "gg" : account.provider === "Facebook" ? "fb_web" : "web";
    const prefixedUserId = `${providerPrefix}:${account.identifier}`;
    const dateISO = getVietnamDateISO(Date.now());
    const duplicated = await isDuplicateClientInDay(prefixedUserId, dateISO);
    if (duplicated) return;

    await createClientRow({
      name: `${account.name} (${account.provider})`,
      link: account.identifier.includes("@") ? `mailto:${account.identifier}` : account.identifier,
      dateISO,
      prefixedUserId
    });
  } catch (err) {
    console.error("SYNC WEB ACCOUNT TO NOTION ERROR:", err.message);
  }
}

app.get("/api/auth/config", (req, res) => {
  res.json({
    success: true,
    googleClientId: GOOGLE_CLIENT_ID,
    facebookAppId: FACEBOOK_APP_ID
  });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const identifier = String(req.body?.identifier || "").trim();
    const password = String(req.body?.password || "");

    if (!identifier) {
      return res.status(400).json({ success: false, error: "Vui lòng nhập Email hoặc Số điện thoại." });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: "Mật khẩu phải có tối thiểu 6 ký tự." });
    }

    const accounts = readJsonFile(ACCOUNTS_FILE, []);
    const exists = accounts.some(a => a.identifier.toLowerCase() === identifier.toLowerCase());
    if (exists) {
      return res.status(409).json({ success: false, error: "Email hoặc số điện thoại này đã được đăng ký." });
    }

    const newAccount = {
      id: "ACC-" + Date.now(),
      name: name || identifier.split("@")[0],
      identifier,
      passwordHash: hashPassword(password),
      provider: "Tài khoản SK82ND",
      createdAt: new Date().toISOString()
    };

    accounts.push(newAccount);
    writeJsonFile(ACCOUNTS_FILE, accounts);
    syncWebAccountToNotionCRM(newAccount);

    return res.json({
      success: true,
      user: {
        id: newAccount.id,
        name: newAccount.name,
        identifier: newAccount.identifier,
        provider: newAccount.provider
      }
    });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    return res.status(500).json({ success: false, error: "Lỗi máy chủ khi đăng ký tài khoản." });
  }
});

app.post("/api/auth/login", (req, res) => {
  try {
    const identifier = String(req.body?.identifier || "").trim();
    const password = String(req.body?.password || "");

    if (!identifier || !password) {
      return res.status(400).json({ success: false, error: "Vui lòng nhập đầy đủ thông tin đăng nhập." });
    }

    const accounts = readJsonFile(ACCOUNTS_FILE, []);
    const account = accounts.find(a => a.identifier.toLowerCase() === identifier.toLowerCase());
    if (!account || !verifyPassword(password, account.passwordHash)) {
      return res.status(401).json({ success: false, error: "Tài khoản hoặc mật khẩu không chính xác." });
    }

    return res.json({
      success: true,
      user: {
        id: account.id,
        name: account.name,
        identifier: account.identifier,
        provider: account.provider || "Tài khoản SK82ND"
      }
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return res.status(500).json({ success: false, error: "Lỗi máy chủ khi đăng nhập." });
  }
});

app.post("/api/auth/oauth", async (req, res) => {
  try {
    const provider = String(req.body?.provider || "").trim();
    const providerId = String(req.body?.providerId || "").trim();
    const identifier = String(req.body?.identifier || "").trim();
    const name = String(req.body?.name || "").trim();
    const picture = String(req.body?.picture || "").trim();

    if (!provider || !identifier) {
      return res.status(400).json({ success: false, error: "Thiếu thông tin xác thực OAuth." });
    }

    const accounts = readJsonFile(ACCOUNTS_FILE, []);
    let account = accounts.find(a => a.identifier.toLowerCase() === identifier.toLowerCase());

    if (!account) {
      account = {
        id: `${provider.toUpperCase()}-${providerId || Date.now()}`,
        name: name || identifier.split("@")[0],
        identifier,
        passwordHash: "",
        provider,
        picture,
        createdAt: new Date().toISOString()
      };
      accounts.push(account);
      writeJsonFile(ACCOUNTS_FILE, accounts);
      syncWebAccountToNotionCRM(account);
    } else {
      account.lastLoginAt = new Date().toISOString();
      if (name) account.name = name;
      writeJsonFile(ACCOUNTS_FILE, accounts);
    }

    return res.json({
      success: true,
      user: {
        id: account.id,
        name: account.name,
        identifier: account.identifier,
        provider: account.provider
      }
    });
  } catch (err) {
    console.error("OAUTH SYNC ERROR:", err);
    return res.status(500).json({ success: false, error: "Lỗi đồng bộ tài khoản OAuth." });
  }
});

// ==========================================
// QUẢN LÝ ĐƠN HÀNG & TRẠNG THÁI QR THANH TOÁN
// ==========================================
app.get("/api/payment/config", (req, res) => {
  res.json({
    success: true,
    bankName: PAYMENT_BANK_NAME,
    accountNo: PAYMENT_ACCOUNT_NO,
    accountName: PAYMENT_ACCOUNT_NAME
  });
});

app.post("/api/orders", (req, res) => {
  try {
    const { orderCode, option, amountToPay, subtotal, entries, customer } = req.body || {};
    if (!orderCode) return res.status(400).json({ success: false, error: "Thiếu mã đơn hàng." });

    const orders = readJsonFile(ORDERS_FILE, {});
    orders[orderCode] = {
      orderCode,
      option: option || "",
      amountToPay: Number(amountToPay || 0),
      subtotal: Number(subtotal || 0),
      entries: Array.isArray(entries) ? entries : [],
      customer: customer || null,
      status: orders[orderCode]?.status || "pending",
      paid: orders[orderCode]?.paid || false,
      updatedAt: new Date().toISOString()
    };
    writeJsonFile(ORDERS_FILE, orders);
    return res.json({ success: true, order: orders[orderCode] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/payment-status", (req, res) => {
  const orderCode = String(req.query.orderCode || "").trim();
  if (!orderCode) return res.status(400).json({ success: false, error: "Thiếu orderCode" });

  const orders = readJsonFile(ORDERS_FILE, {});
  const order = orders[orderCode];
  if (!order) {
    return res.json({ success: true, orderCode, paid: false, status: "pending" });
  }
  return res.json({
    success: true,
    orderCode,
    paid: Boolean(order.paid || order.status === "paid"),
    status: order.status || "pending"
  });
});

app.post("/api/payment-webhook", (req, res) => {
  try {
    if (PAYMENT_WEBHOOK_SECRET) {
      const incomingSecret = req.headers["x-webhook-secret"] || req.query.secret || req.body?.secret;
      if (incomingSecret !== PAYMENT_WEBHOOK_SECRET) {
        return res.sendStatus(403);
      }
    }

    const content = String(
      req.body?.content ||
      req.body?.description ||
      req.body?.addInfo ||
      req.body?.orderCode ||
      ""
    ).toUpperCase();

    const match = content.match(/SK82-\d{4,8}/);
    if (!match) {
      return res.status(200).json({ success: true, matched: false });
    }

    const orderCode = match[0];
    const orders = readJsonFile(ORDERS_FILE, {});
    orders[orderCode] = {
      ...(orders[orderCode] || { orderCode }),
      status: "paid",
      paid: true,
      paidAt: new Date().toISOString(),
      rawPayload: req.body
    };
    writeJsonFile(ORDERS_FILE, orders);
    console.log(`[PAYMENT RECEIVED] ${orderCode}`);
    return res.json({ success: true, matched: true, orderCode });
  } catch (err) {
    console.error("PAYMENT WEBHOOK ERROR:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// TRANG CHÍNH SÁCH QUYỀN RIÊNG TƯ & XÓA DỮ LIỆU (CHO META APP)
// ==========================================
app.get("/privacy-policy", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chính sách quyền riêng tư — SK82ND SkateShop</title>
</head>
<body style="font-family: Arial, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 16px; line-height: 1.6; color: #0f172a;">
  <h1>Chính sách quyền riêng tư — SK82ND SkateShop</h1>
  <p>SK82ND SkateShop thu thập họ tên, email hoặc thông tin tài khoản đăng nhập (Google, Facebook hoặc tài khoản web) và mã đơn hàng nhằm hỗ trợ đặt hàng, thanh toán và chăm sóc khách hàng.</p>
  <p>Chúng tôi không bán hoặc chia sẻ thông tin cá nhân của bạn cho bên thứ ba vì mục đích quảng cáo trái phép.</p>
  <p>Liên hệ hỗ trợ: <a href="mailto:phamphuc2901@gmail.com">phamphuc2901@gmail.com</a> hoặc Zalo / SĐT: 0333 501 537.</p>
</body>
</html>`);
});

app.get("/data-deletion", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hướng dẫn xóa dữ liệu người dùng — SK82ND SkateShop</title>
</head>
<body style="font-family: Arial, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 16px; line-height: 1.6; color: #0f172a;">
  <h1>Hướng dẫn xóa dữ liệu người dùng — SK82ND SkateShop</h1>
  <p>Để yêu cầu xóa dữ liệu tài khoản hoặc thông tin khách hàng gắn với SK82ND SkateShop, vui lòng gửi email tới <a href="mailto:phamphuc2901@gmail.com">phamphuc2901@gmail.com</a> hoặc nhắn trực tiếp qua Facebook / Zalo 0333 501 537 với nội dung <strong>"Yêu cầu xóa dữ liệu - SK82ND"</strong> kèm email hoặc thông tin tài khoản đã đăng ký.</p>
  <p>Chúng tôi sẽ tiếp nhận và xử lý yêu cầu xóa dữ liệu trong thời gian sớm nhất sau khi xác minh.</p>
</body>
</html>`);
});

// ==========================================
// ROUTES WEB & KHO HÀNG (GIỮ NGUYÊN)
// ==========================================
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
