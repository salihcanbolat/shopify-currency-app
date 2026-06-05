import express from "express";
import crypto from "crypto";
import { saveToken, loadAllTokens } from "./db.js";
import { shopifyGraphQL } from "./graphql.js";

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
  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SCOPES}&state=${state}&redirect_uri=${redirectUri}&expiring=1`;

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
        expiring: 1,
      }),
    });

    const tokenData = await tokenResponse.json();
    const { access_token, refresh_token, expires_in } = tokenData;
    if (!access_token) throw new Error("Token alınamadı");

    // Token'ı (varsa refresh_token + son kullanma ile) DB'ye kaydet
    const expiresAt = expires_in ? Date.now() + expires_in * 1000 : null;
    await saveToken(shop, access_token, refresh_token || null, expiresAt);

    // products/create webhook'unu otomatik kaydet (GraphQL)
    try {
      const mutation = `
        mutation webhookCreate($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
          webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
            userErrors { field message }
          }
        }
      `;
      await shopifyGraphQL(shop, access_token, mutation, {
        topic: "PRODUCTS_CREATE",
        sub: { callbackUrl: `${HOST}/webhooks/products/create`, format: "JSON" },
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