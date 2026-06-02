import express from "express";
import crypto from "crypto";
import fs from "fs";

export const gdprRouter = express.Router();

const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;

// HMAC doğrulama
function verifyWebhook(req) {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  if (!hmac) return false;

  const body = JSON.stringify(req.body);
  const generated = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(body, "utf8")
    .digest("base64");

  return crypto.timingSafeEqual(
    Buffer.from(generated),
    Buffer.from(hmac)
  );
}

function logGdpr(type, shop, data) {
  const entry = {
    type,
    shop,
    data,
    timestamp: new Date().toISOString(),
  };
  console.log(`📋 GDPR ${type}:`, JSON.stringify(entry));

  // Log dosyasına kaydet
  try {
    let logs = [];
    try { logs = JSON.parse(fs.readFileSync("gdpr_logs.json", "utf8")); } catch {}
    logs.push(entry);
    // Son 1000 kaydı tut
    if (logs.length > 1000) logs = logs.slice(-1000);
    fs.writeFileSync("gdpr_logs.json", JSON.stringify(logs, null, 2));
  } catch(e) {
    console.error("GDPR log yazma hatası:", e.message);
  }
}

// 1. Müşteri veri talebi
// Shopify bir müşterinin verilerini talep ettiğinde çağrılır
gdprRouter.post("/customers/data_request", express.json(), (req, res) => {
  if (!verifyWebhook(req)) {
    return res.status(401).send("Unauthorized");
  }

  const { shop_domain, customer } = req.body;
  logGdpr("customers/data_request", shop_domain, { customer_id: customer?.id });

  // Bu uygulama müşteri verisi saklamaz — sadece ürün fiyatlarını günceller
  // Shopify'a 200 döndürmek yeterli
  res.status(200).json({
    message: "Bu uygulama müşteri kişisel verisi saklamaz.",
  });
});

// 2. Müşteri veri silme
// Shopify bir müşterinin verilerinin silinmesini istediğinde çağrılır
gdprRouter.post("/customers/redact", express.json(), (req, res) => {
  if (!verifyWebhook(req)) {
    return res.status(401).send("Unauthorized");
  }

  const { shop_domain, customer } = req.body;
  logGdpr("customers/redact", shop_domain, { customer_id: customer?.id });

  // Bu uygulama müşteri verisi saklamaz — işlem gerekmez
  res.status(200).json({
    message: "Müşteri verisi bulunamadı — bu uygulama müşteri verisi saklamaz.",
  });
});

// 3. Mağaza veri silme
// Uygulama kaldırıldığında Shopify bu webhook'u çağırır
gdprRouter.post("/shop/redact", express.json(), (req, res) => {
  if (!verifyWebhook(req)) {
    return res.status(401).send("Unauthorized");
  }

  const { shop_domain } = req.body;
  logGdpr("shop/redact", shop_domain, {});

  // Mağazaya ait tüm verileri temizle
  try {
    // Token sil
    let tokens = {};
    try { tokens = JSON.parse(fs.readFileSync("tokens.json", "utf8")); } catch {}
    delete tokens[shop_domain];
    fs.writeFileSync("tokens.json", JSON.stringify(tokens, null, 2));
    if (global.shopTokens) delete global.shopTokens[shop_domain];

    // Ayarları sil
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync("settings.json", "utf8")); } catch {}
    delete settings[shop_domain];
    fs.writeFileSync("settings.json", JSON.stringify(settings, null, 2));
    if (global.shopSettings) delete global.shopSettings[shop_domain];

    console.log(`🗑️ Mağaza verileri silindi: ${shop_domain}`);
  } catch(e) {
    console.error("Mağaza verisi silme hatası:", e.message);
  }

  res.status(200).json({ message: "Mağaza verileri silindi." });
});