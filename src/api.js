import express from "express";
import fs from "fs";
import { getExchangeRate } from "./rateService.js";
import { updateAllProductPrices } from "./priceUpdater.js";

export const apiRouter = express.Router();

global.shopSettings = global.shopSettings || {};

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync("tokens.json", "utf8"));
  } catch {
    return {};
  }
}

function getToken(shop) {
  const tokens = loadTokens();
  return tokens[shop];
}

// GET /api/currencies
apiRouter.get("/currencies", (req, res) => {
  res.json([
    { code: "USD", name: "ABD Doları", symbol: "$", flag: "🇺🇸" },
    { code: "EUR", name: "Euro", symbol: "€", flag: "🇪🇺" },
    { code: "GBP", name: "İngiliz Sterlini", symbol: "£", flag: "🇬🇧" },
    { code: "TRY", name: "Türk Lirası", symbol: "₺", flag: "🇹🇷" },
    { code: "JPY", name: "Japon Yeni", symbol: "¥", flag: "🇯🇵" },
    { code: "CHF", name: "İsviçre Frangı", symbol: "Fr", flag: "🇨🇭" },
    { code: "CAD", name: "Kanada Doları", symbol: "CA$", flag: "🇨🇦" },
    { code: "AUD", name: "Avustralya Doları", symbol: "A$", flag: "🇦🇺" },
    { code: "SAR", name: "Suudi Riyali", symbol: "﷼", flag: "🇸🇦" },
    { code: "AED", name: "BAE Dirhemi", symbol: "د.إ", flag: "🇦🇪" },
    { code: "RUB", name: "Rus Rublesi", symbol: "₽", flag: "🇷🇺" },
    { code: "CNY", name: "Çin Yuanı", symbol: "¥", flag: "🇨🇳" },
  ]);
});

// GET /api/settings
apiRouter.get("/settings", (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: "Missing shop" });
  const settings = global.shopSettings[shop] || {
    baseCurrency: "USD", targetCurrency: "TRY",
    margin: 0, autoUpdate: true, lastRate: null, lastUpdated: null,
  };
  res.json(settings);
});

// POST /api/settings
apiRouter.post("/settings", async (req, res) => {
  const { shop, baseCurrency, targetCurrency, margin, autoUpdate } = req.body;
  if (!shop) return res.status(400).json({ error: "Missing shop" });
  const rate = await getExchangeRate(baseCurrency, targetCurrency);
  global.shopSettings[shop] = {
    baseCurrency, targetCurrency,
    margin: parseFloat(margin) || 0,
    autoUpdate: !!autoUpdate,
    lastRate: rate,
    lastUpdated: new Date().toISOString(),
  };
  res.json({ success: true, rate });
});

// GET /api/rate
apiRouter.get("/rate", async (req, res) => {
  const { base, target } = req.query;
  if (!base || !target) return res.status(400).json({ error: "Missing params" });
  try {
    const rate = await getExchangeRate(base, target);
    res.json({ base, target, rate, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: "Rate fetch failed" });
  }
});

// GET /api/products — tüm ürünleri çek
apiRouter.get("/products", async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: "Missing shop" });

  const token = getToken(shop);
  if (!token) return res.status(401).json({ error: "Shop not authenticated" });

  try {
    let allProducts = [];
    let pageInfo = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const url = pageInfo
        ? `https://${shop}/admin/api/2024-01/products.json?limit=250&page_info=${pageInfo}`
        : `https://${shop}/admin/api/2024-01/products.json?limit=250&fields=id,title,image,variants`;

      const response = await fetch(url, {
        headers: { "X-Shopify-Access-Token": token },
      });

      const linkHeader = response.headers.get("link");
      const data = await response.json();

      if (data.errors) throw new Error(JSON.stringify(data.errors));

      allProducts = allProducts.concat(data.products || []);

      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/page_info=([^&>]+)[^>]*>;\s*rel="next"/);
        pageInfo = match ? match[1] : null;
        hasNextPage = !!pageInfo;
      } else {
        hasNextPage = false;
      }
    }

    const products = allProducts.map((p) => ({
      id: p.id,
      title: p.title,
      image: p.image?.src || null,
      variants: p.variants.map((v) => ({
        id: v.id,           // sayısal ID — REST API'den geliyor
        title: v.title,
        price: v.price,
        compareAtPrice: v.compare_at_price,
        usdPrice: v.compare_at_price || "",
      })),
    }));

    res.json({ products, total: products.length });
  } catch (err) {
    console.error("Products fetch error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/product/update — tek varyant fiyatı güncelle
apiRouter.post("/product/update", async (req, res) => {
  const { shop, variantId, usdPrice } = req.body;
  if (!shop || !variantId || !usdPrice) {
    return res.status(400).json({ error: "Missing params" });
  }

  const token = getToken(shop);
  if (!token) return res.status(401).json({ error: "Shop not authenticated" });

  const settings = global.shopSettings[shop] || {
    baseCurrency: "USD", targetCurrency: "TRY", margin: 0,
  };

  try {
    const rate = await getExchangeRate(settings.baseCurrency, settings.targetCurrency);
    const effectiveRate = rate * (1 + (settings.margin || 0) / 100);
    const tryPrice = (parseFloat(usdPrice) * effectiveRate).toFixed(2);
    const usdFormatted = parseFloat(usdPrice).toFixed(2);

    console.log(`Güncelleniyor: variant=${variantId}, USD=${usdFormatted}, TRY=${tryPrice}, kur=${effectiveRate}`);

    // REST API ile güncelle (GraphQL GID gerektirmez)
    const response = await fetch(
      `https://${shop}/admin/api/2024-01/variants/${variantId}.json`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({
          variant: {
            id: variantId,
            price: tryPrice,
            compare_at_price: usdFormatted,
          },
        }),
      }
    );

    const result = await response.json();
    console.log("Shopify yanıtı:", JSON.stringify(result));

    if (result.errors) throw new Error(JSON.stringify(result.errors));
    if (!result.variant) throw new Error("Variant güncellenemedi");

    res.json({
      success: true,
      tryPrice,
      rate: effectiveRate,
      variant: result.variant,
    });
  } catch (err) {
    console.error("Update error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync — tüm ürünleri senkronize et
apiRouter.post("/sync", async (req, res) => {
  const { shop } = req.body;
  if (!shop) return res.status(400).json({ error: "Missing shop" });

  const token = getToken(shop);
  if (!token) return res.status(401).json({ error: "Shop not authenticated" });

  const settings = global.shopSettings[shop];
  if (!settings) return res.status(400).json({ error: "No settings configured" });

  try {
    const rate = await getExchangeRate(settings.baseCurrency, settings.targetCurrency);
    const effectiveRate = rate * (1 + settings.margin / 100);
    console.log(`Sync başlatıldı: ${settings.baseCurrency} → ${settings.targetCurrency}, kur: ${rate}, marj: ${settings.margin}%, efektif: ${effectiveRate}`);
    const result = await updateAllProductPrices(shop, token, effectiveRate);

    global.shopSettings[shop].lastRate = rate;
    global.shopSettings[shop].lastUpdated = new Date().toISOString();

    res.json({ success: true, rate, effectiveRate, updatedCount: result.updatedCount });
  } catch (err) {
    console.error("Sync error:", err);
    res.status(500).json({ error: "Sync failed", details: err.message });
  }
});