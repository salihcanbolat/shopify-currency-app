import express from "express";
import crypto from "crypto";
import { getToken, getSettings } from "./db.js";
import { getExchangeRate } from "./rateService.js";

export const productWebhookRouter = express.Router();

const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;

// Webhook HMAC doğrulama (raw body gerekir)
function verifyWebhook(rawBody, hmacHeader) {
  if (!hmacHeader) return false;
  const generated = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(generated), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

// Yuvarlama (priceUpdater ile aynı mantık)
function applyRounding(price, rule) {
  const p = parseFloat(price);
  switch(rule) {
    case "up_99": return (Math.ceil(p) - 0.01).toFixed(2);
    case "up_95": return (Math.ceil(p) - 0.05).toFixed(2);
    case "nearest_int": return Math.round(p).toFixed(2);
    case "up_int": return Math.ceil(p).toFixed(2);
    case "nearest_5": return (Math.round(p / 5) * 5).toFixed(2);
    case "nearest_10": return (Math.round(p / 10) * 10).toFixed(2);
    default: return p.toFixed(2);
  }
}

// products/create — yeni ürün eklenince otomatik fiyatla
productWebhookRouter.post("/products/create",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const rawBody = req.body.toString("utf8");
    const hmac = req.headers["x-shopify-hmac-sha256"];
    const shop = req.headers["x-shopify-shop-domain"];

    if (!verifyWebhook(rawBody, hmac)) {
      return res.status(401).send("Unauthorized");
    }

    // Shopify'a hemen 200 dön (webhook timeout'u önle)
    res.status(200).send("OK");

    // Arka planda fiyatlama yap
    try {
      const product = JSON.parse(rawBody);
      const settings = await getSettings(shop);

      // Otomatik fiyatlama kapalıysa veya ayar yoksa çık
      if (!settings || !settings.autoUpdate || !settings.autoPriceNewProducts) {
        console.log(`ℹ️ ${shop}: Yeni ürün otomatik fiyatlama kapalı`);
        return;
      }

      const token = await getToken(shop);
      if (!token) return;

      const pair = (settings.currencies || [])[0] || { base: "USD", target: "TRY", margin: 0 };
      const rate = await getExchangeRate(pair.base, pair.target);
      const effectiveRate = rate * (1 + (pair.margin || 0) / 100);
      const rounding = settings.rounding || "none";
      const minPrice = parseFloat(settings.minPrice) || 0;

      console.log(`🆕 ${shop}: Yeni ürün "${product.title}" otomatik fiyatlanıyor`);

      for (const variant of (product.variants || [])) {
        const usdPrice = parseFloat(variant.price);
        if (!usdPrice || usdPrice <= 0) continue;

        let tryPrice = usdPrice * effectiveRate;
        tryPrice = applyRounding(tryPrice, rounding);
        if (minPrice > 0) tryPrice = Math.max(parseFloat(tryPrice), minPrice).toFixed(2);

        await fetch(`https://${shop}/admin/api/2024-01/variants/${variant.id}.json`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
          body: JSON.stringify({
            variant: { id: variant.id, price: tryPrice, compare_at_price: usdPrice.toFixed(2) }
          }),
        });

        console.log(`✅ ${product.title} / ${variant.title}: $${usdPrice} → ₺${tryPrice}`);
      }
    } catch(err) {
      console.error("Yeni ürün fiyatlama hatası:", err.message);
    }
  }
);