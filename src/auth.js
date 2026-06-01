import express from "express";
import crypto from "crypto";
import fs from "fs";

export const shopifyAuth = express.Router();

const SCOPES = "write_products,read_products,read_inventory";
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const HOST = process.env.HOST || "https://your-app.ngrok.io";
const TOKENS_FILE = "tokens.json";

function saveToken(shop, token) {
  let tokens = {};
  try {
    tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
  } catch {}
  tokens[shop] = token;
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  global.shopTokens = tokens;
  console.log(`✅ Token kaydedildi: ${shop}`);
}

export function loadTokens() {
  try {
    const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
    global.shopTokens = tokens;
    console.log(`📦 Tokenlar yüklendi: ${Object.keys(tokens).join(", ")}`);
    return tokens;
  } catch {
    global.shopTokens = {};
    return {};
  }
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

  if (!shop || !code) {
    return res.status(400).send("Missing required parameters");
  }

  // Verify HMAC
  const queryParams = { ...req.query };
  delete queryParams.hmac;
  const message = Object.keys(queryParams)
    .sort()
    .map((key) => `${key}=${queryParams[key]}`)
    .join("&");
  const generatedHmac = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(message)
    .digest("hex");

  if (generatedHmac !== hmac) {
    return res.status(400).send("HMAC validation failed");
  }

  // Exchange code for access token
  try {
    const tokenResponse = await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: SHOPIFY_API_KEY,
          client_secret: SHOPIFY_API_SECRET,
          code,
        }),
      }
    );

    const { access_token } = await tokenResponse.json();

    if (!access_token) {
      throw new Error("Token alınamadı");
    }

    saveToken(shop, access_token);

    res.redirect(`https://${shop}/admin/apps/${SHOPIFY_API_KEY}`);
  } catch (err) {
    console.error("OAuth error:", err);
    res.status(500).send("Authentication failed: " + err.message);
  }
});