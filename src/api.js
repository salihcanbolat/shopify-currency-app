import express from "express";
import fs from "fs";
import { getExchangeRate } from "./rateService.js";
import { updateAllProductPrices, updateCollectionPrices } from "./priceUpdater.js";

export const apiRouter = express.Router();

global.shopSettings = global.shopSettings || {};

function loadTokens() {
  try { return JSON.parse(fs.readFileSync("tokens.json", "utf8")); } catch { return {}; }
}

function getToken(shop) { return loadTokens()[shop]; }

function saveSettings(shop, settings) {
  global.shopSettings[shop] = settings;
  try {
    const all = JSON.parse(fs.readFileSync("settings.json", "utf8") || "{}");
    all[shop] = settings;
    fs.writeFileSync("settings.json", JSON.stringify(all, null, 2));
  } catch {
    fs.writeFileSync("settings.json", JSON.stringify({ [shop]: settings }, null, 2));
  }
}

function loadAllSettings() {
  try {
    const all = JSON.parse(fs.readFileSync("settings.json", "utf8"));
    Object.assign(global.shopSettings, all);
  } catch {}
}
loadAllSettings();

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
    currencies: [{ base: "USD", target: "TRY", margin: 0 }],
    autoUpdate: true,
    scheduleTime: "09:00",
    lastUpdated: null,
  };
  res.json(settings);
});

// POST /api/settings
apiRouter.post("/settings", async (req, res) => {
  const { shop, currencies, baseCurrency, targets, autoUpdate, scheduleTime } = req.body;
  if (!shop) return res.status(400).json({ error: "Missing shop" });

  // Yeni format: baseCurrency + targets[] → currencies[] formatına çevir
  let currencyList = currencies || [];
  if (baseCurrency && targets && targets.length > 0) {
    currencyList = targets.map(t => ({ base: baseCurrency, target: t.code, margin: t.margin || 0 }));
  }

  const rates = {};
  for (const c of currencyList) {
    try {
      const rate = await getExchangeRate(c.base, c.target);
      rates[`${c.base}_${c.target}`] = rate;
    } catch(e) { console.error(`Rate fetch error ${c.base}→${c.target}:`, e.message); }
  }

  const settings = {
    currencies: currencyList,
    baseCurrency: baseCurrency || currencyList[0]?.base || "USD",
    targets: targets || currencyList.map(c => ({ code: c.target, margin: c.margin || 0 })),
    autoUpdate: !!autoUpdate,
    scheduleTime: scheduleTime || "09:00",
    lastUpdated: new Date().toISOString(),
    rates,
  };

  saveSettings(shop, settings);
  res.json({ success: true, rates });
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

// GET /api/collections — koleksiyonları getir
apiRouter.get("/collections", async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: "Missing shop" });
  const token = getToken(shop);
  if (!token) return res.status(401).json({ error: "Shop not authenticated" });

  try {
    const res2 = await fetch(`https://${shop}/admin/api/2024-01/custom_collections.json?limit=250&fields=id,title,image`, {
      headers: { "X-Shopify-Access-Token": token },
    });
    const data = await res2.json();

    const res3 = await fetch(`https://${shop}/admin/api/2024-01/smart_collections.json?limit=250&fields=id,title,image`, {
      headers: { "X-Shopify-Access-Token": token },
    });
    const data3 = await res3.json();

    const collections = [
      { id: "all", title: "Tüm Ürünler", image: null },
      ...(data.custom_collections || []).map(c => ({ id: c.id, title: c.title, image: c.image?.src || null })),
      ...(data3.smart_collections || []).map(c => ({ id: c.id, title: c.title, image: c.image?.src || null })),
    ];

    res.json({ collections });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/products
apiRouter.get("/products", async (req, res) => {
  const { shop, collection_id } = req.query;
  if (!shop) return res.status(400).json({ error: "Missing shop" });
  const token = getToken(shop);
  if (!token) return res.status(401).json({ error: "Shop not authenticated" });

  try {
    let allProducts = [];
    let pageInfo = null;
    let hasNextPage = true;

    while (hasNextPage) {
      let url;
      if (collection_id && collection_id !== "all") {
        url = pageInfo
          ? `https://${shop}/admin/api/2024-01/products.json?limit=250&page_info=${pageInfo}`
          : `https://${shop}/admin/api/2024-01/products.json?limit=250&fields=id,title,image,variants&collection_id=${collection_id}`;
      } else {
        url = pageInfo
          ? `https://${shop}/admin/api/2024-01/products.json?limit=250&page_info=${pageInfo}`
          : `https://${shop}/admin/api/2024-01/products.json?limit=250&fields=id,title,image,variants`;
      }

      const response = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
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

    const products = allProducts.map(p => ({
      id: p.id,
      title: p.title,
      image: p.image?.src || null,
      variants: p.variants.map(v => ({
        id: v.id,
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

// POST /api/product/update
apiRouter.post("/product/update", async (req, res) => {
  const { shop, variantId, usdPrice, baseCurrency, targetCurrency, margin } = req.body;
  if (!shop || !variantId || !usdPrice) return res.status(400).json({ error: "Missing params" });

  const token = getToken(shop);
  if (!token) return res.status(401).json({ error: "Shop not authenticated" });

  const settings = global.shopSettings[shop];
  const base = baseCurrency || settings?.currencies?.[0]?.base || "USD";
  const target = targetCurrency || settings?.currencies?.[0]?.target || "TRY";
  const marginVal = margin ?? settings?.currencies?.[0]?.margin ?? 0;

  try {
    const rate = await getExchangeRate(base, target);
    const effectiveRate = rate * (1 + marginVal / 100);
    const tryPrice = (parseFloat(usdPrice) * effectiveRate).toFixed(2);

    const response = await fetch(`https://${shop}/admin/api/2024-01/variants/${variantId}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ variant: { id: variantId, price: tryPrice, compare_at_price: parseFloat(usdPrice).toFixed(2) } }),
    });

    const result = await response.json();
    if (result.errors) throw new Error(JSON.stringify(result.errors));
    if (!result.variant) throw new Error("Variant güncellenemedi");

    res.json({ success: true, tryPrice, rate: effectiveRate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync
apiRouter.post("/sync", async (req, res) => {
  const { shop, collection_id } = req.body;
  if (!shop) return res.status(400).json({ error: "Missing shop" });

  const token = getToken(shop);
  if (!token) return res.status(401).json({ error: "Shop not authenticated" });

  const settings = global.shopSettings[shop];
  if (!settings) return res.status(400).json({ error: "No settings configured" });

  try {
    let totalUpdated = 0;

    for (const currencyPair of (settings.currencies || [])) {
      const rate = await getExchangeRate(currencyPair.base, currencyPair.target);
      const effectiveRate = rate * (1 + (currencyPair.margin || 0) / 100);
      console.log(`Sync: ${currencyPair.base}→${currencyPair.target}, kur: ${effectiveRate}, koleksiyon: ${collection_id || "all"}`);

      const result = collection_id && collection_id !== "all"
        ? await updateCollectionPrices(shop, token, effectiveRate, collection_id)
        : await updateAllProductPrices(shop, token, effectiveRate);

      totalUpdated += result.updatedCount;
    }

    settings.lastUpdated = new Date().toISOString();
    saveSettings(shop, settings);

    res.json({ success: true, updatedCount: totalUpdated });
  } catch (err) {
    console.error("Sync error:", err);
    res.status(500).json({ error: "Sync failed", details: err.message });
  }
});

// GET /api/dashboard
apiRouter.get("/dashboard", async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: "Missing shop" });

  const token = getToken(shop);
  if (!token) return res.status(401).json({ error: "Shop not authenticated" });

  const settings = global.shopSettings[shop] || {};

  try {
    // Ürün sayısı
    const countRes = await fetch(`https://${shop}/admin/api/2024-01/products/count.json`, {
      headers: { "X-Shopify-Access-Token": token },
    });
    const countData = await countRes.json();

    // Güncel kurlar
    const rates = [];
    for (const c of (settings.currencies || [{ base: "USD", target: "TRY", margin: 0 }])) {
      const rate = await getExchangeRate(c.base, c.target);
      const effectiveRate = rate * (1 + (c.margin || 0) / 100);
      rates.push({ base: c.base, target: c.target, rate, effectiveRate, margin: c.margin || 0 });
    }

    res.json({
      productCount: countData.count || 0,
      lastUpdated: settings.lastUpdated || null,
      rates,
      autoUpdate: settings.autoUpdate || false,
      scheduleTime: settings.scheduleTime || "09:00",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});