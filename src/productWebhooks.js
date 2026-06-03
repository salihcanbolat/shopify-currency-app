import express from "express";
import crypto from "crypto";
import { getSettings, addPendingProduct } from "./db.js";

export const productWebhookRouter = express.Router();

const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;

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

// products/create — yeni ürün eklenince USD bekleyenler listesine al
productWebhookRouter.post("/products/create",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const rawBody = req.body.toString("utf8");
    const hmac = req.headers["x-shopify-hmac-sha256"];
    const shop = req.headers["x-shopify-shop-domain"];

    if (!verifyWebhook(rawBody, hmac)) {
      return res.status(401).send("Unauthorized");
    }

    res.status(200).send("OK");

    try {
      const product = JSON.parse(rawBody);
      const settings = await getSettings(shop);

      // Otomatik fiyatlama özelliği kapalıysa bekleyenlere ekleme
      if (!settings || !settings.autoPriceNewProducts) {
        return;
      }

      const image = product.image?.src || product.images?.[0]?.src || null;

      // Her varyantı bekleyenler listesine ekle
      for (const variant of (product.variants || [])) {
        await addPendingProduct(shop, {
          productId: String(product.id),
          productTitle: product.title,
          variantId: String(variant.id),
          variantTitle: variant.title,
          currentPrice: variant.price,
          image,
        });
      }

      console.log(`🆕 ${shop}: "${product.title}" USD bekleyenler listesine eklendi (${product.variants?.length || 0} varyant)`);
    } catch(err) {
      console.error("Yeni ürün webhook hatası:", err.message);
    }
  }
);