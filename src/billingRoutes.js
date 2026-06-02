import express from "express";
import { createSubscription, checkSubscription, isPremium, PLANS } from "./billing.js";
import { getToken, saveSubscription, getSubscription } from "./db.js";

export const billingRouter = express.Router();

// GET /billing/status?shop=xxx — plan durumu
billingRouter.get("/status", async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: "Missing shop" });

  const token = await getToken(shop);
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  try {
    const sub = await checkSubscription(shop, token);
    res.json({
      ...sub,
      plans: PLANS,
      isPremium: sub.plan === "premium" && sub.status === "active",
    });
  } catch(e) {
    // Abonelik kontrolü başarısız olursa mevcut durumu döndür
    const sub = getSubscription(shop);
    res.json({ ...sub, plans: PLANS, isPremium: isPremium(shop) });
  }
});

// POST /billing/subscribe — premium'a geç
billingRouter.post("/subscribe", async (req, res) => {
  const { shop } = req.body;
  if (!shop) return res.status(400).json({ error: "Missing shop" });

  const token = await getToken(shop);
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  try {
    const result = await createSubscription(shop, token);
    res.json({ success: true, confirmationUrl: result.confirmationUrl });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /billing/confirm — Shopify ödeme onayı sonrası redirect
billingRouter.get("/confirm", async (req, res) => {
  const { shop, charge_id } = req.query;
  if (!shop) return res.redirect("/");

  const token = await getToken(shop);
  if (token) {
    try {
      await checkSubscription(shop, token);
    } catch(e) {
      console.error("Subscription confirm error:", e.message);
    }
  }

  // Shopify Admin'deki uygulamaya yönlendir
  const apiKey = process.env.SHOPIFY_API_KEY;
  res.redirect(`https://admin.shopify.com/store/${shop.replace(".myshopify.com","")}/apps/${apiKey}`);
});

// POST /billing/cancel — iptal
billingRouter.post("/cancel", async (req, res) => {
  const { shop } = req.body;
  if (!shop) return res.status(400).json({ error: "Missing shop" });

  try {
    let subs = {};
    try { subs = JSON.parse(fs.readFileSync("subscriptions.json", "utf8")); } catch {}
    subs[shop] = { plan: "free", status: "active" };
    fs.writeFileSync("subscriptions.json", JSON.stringify(subs, null, 2));
    if (global.shopSubscriptions) global.shopSubscriptions[shop] = { plan: "free", status: "active" };
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});