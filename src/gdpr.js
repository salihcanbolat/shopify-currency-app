import express from "express";
import crypto from "crypto";

export const gdprRouter = express.Router();

const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;

// HMAC doğrulama — RAW body üzerinden yapılır (Shopify'ın gönderdiği ham byte'lar).
// req.rawBody, express.raw() ile yakalanan Buffer'dır.
function verifyWebhook(req) {
  const hmac = req.get("X-Shopify-Hmac-Sha256");
  if (!hmac || !req.rawBody) return false;

  const generated = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(req.rawBody) // Buffer — raw body, stringify YOK
    .digest("base64");

  // Uzunluklar farklıysa timingSafeEqual patlar; önce kontrol et
  const a = Buffer.from(generated, "utf8");
  const b = Buffer.from(hmac, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// raw body'yi JSON'a çevir (doğrulama sonrası kullanım için)
function parseBody(req) {
  try { return JSON.parse(req.rawBody.toString("utf8")); }
  catch { return {}; }
}

function logGdpr(type, shop, data) {
  console.log(`📋 GDPR ${type}:`, JSON.stringify({ type, shop, data, timestamp: new Date().toISOString() }));
}

// 1. Müşteri veri talebi
gdprRouter.post("/customers/data_request", (req, res) => {
  if (!verifyWebhook(req)) return res.status(401).send("Unauthorized");
  const body = parseBody(req);
  logGdpr("customers/data_request", body.shop_domain, { customer_id: body.customer?.id });
  // Bu uygulama müşteri kişisel verisi saklamaz
  res.status(200).send();
});

// 2. Müşteri veri silme
gdprRouter.post("/customers/redact", (req, res) => {
  if (!verifyWebhook(req)) return res.status(401).send("Unauthorized");
  const body = parseBody(req);
  logGdpr("customers/redact", body.shop_domain, { customer_id: body.customer?.id });
  // Müşteri verisi saklanmadığı için yapılacak işlem yok
  res.status(200).send();
});

// 3. Mağaza veri silme (uygulama kaldırılınca)
gdprRouter.post("/shop/redact", async (req, res) => {
  if (!verifyWebhook(req)) return res.status(401).send("Unauthorized");
  const body = parseBody(req);
  const shop = body.shop_domain;
  logGdpr("shop/redact", shop, {});

  // Mağazaya ait verileri DB'den ve RAM'den temizle
  try {
    const { deleteShopData } = await import("./db.js");
    if (typeof deleteShopData === "function") {
      await deleteShopData(shop);
    }
  } catch (e) {
    console.error("shop/redact veri silme hatası:", e.message);
  }
  if (global.shopTokens) delete global.shopTokens[shop];
  if (global.shopSettings) delete global.shopSettings[shop];

  res.status(200).send();
});