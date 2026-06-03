import express from "express";
import crypto from "crypto";
import { saveToken, loadAllTokens } from "./db.js";

export const shopifyAuth = express.Router();

const SCOPES = "write_products,read_products,read_inventory";
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const HOST = process.env.HOST || "https://shopify-currency-app-production.up.railway.app";

export async function loadTokens() {
  await loadAllTokens();
}

// Step 1: Redirect to Shopify OAuth
shopifyAuth.get("/", (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send("Missing shop parameter");

  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${HOST}/auth/callback`;
  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SCOPES}&state=${state}&redirect_uri=${redirectUri}`;

  res.redirect(installUrl);
});

// Step 2: Handle OAuth callback
shopifyAuth.get("/callback", async (req, res) => {
  const { shop, hmac, code } = req.query;

  if (!shop || !code) return res.status(400).send("Missing parameters");

  // HMAC doğrulama
  const queryParams = { ...req.query };
  delete queryParams.hmac;
  const message = Object.keys(queryParams).sort()
    .map(key => `${key}=${queryParams[key]}`).join("&");
  const generatedHmac = crypto.createHmac("sha256", SHOPIFY_API_SECRET)
    .update(message).digest("hex");

  if (generatedHmac !== hmac) return res.status(400).send("HMAC validation failed");

  try {
    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
      }),
    });

    const { access_token } = await tokenResponse.json();
    if (!access_token) throw new Error("Token alınamadı");

    // Token'ı DB'ye kaydet
    await saveToken(shop, access_token);

    // products/create webhook'unu otomatik kaydet
    try {
      await fetch(`https://${shop}/admin/api/2024-01/webhooks.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": access_token },
        body: JSON.stringify({
          webhook: {
            topic: "products/create",
            address: `${HOST}/webhooks/products/create`,
            format: "json",
          },
        }),
      });
      console.log(`\u2705 products/create webhook kaydedildi: ${shop}`);
    } catch(e) {
      console.error("Webhook kayit hatasi:", e.message);
    }

    const storeName = shop.replace(".myshopify.com", "");
    res.redirect(`https://admin.shopify.com/store/${storeName}/apps/${SHOPIFY_API_KEY}`);
  } catch(err) {
    console.error("OAuth error:", err);
    res.status(500).send("Authentication failed: " + err.message);
  }
});