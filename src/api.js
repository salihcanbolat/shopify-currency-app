import express from "express";
import { getExchangeRate } from "./rateService.js";
import { updateAllProductPrices, updateCollectionPrices, previewPrices, rollbackPrices } from "./priceUpdater.js";
import { isPremium, getProductLimit } from "./billing.js";
import { getToken, getSettings, saveSettings as dbSaveSettings, getSubscription,
         getPriceHistory, getActivityLog, getBatchForRollback, getLastBatch,
         getPendingProducts, removePendingProduct, countPendingProducts } from "./db.js";
import { verifySessionToken, resolveShop } from "./verifyToken.js";
import { shopifyGraphQL, numericId, toGid, API_VERSION, updateVariantPrice } from "./graphql.js";

export const apiRouter = express.Router();

global.shopSettings = global.shopSettings || {};

// /api/currencies hariç tüm endpoint'lerde session token doğrulaması
// (currencies statik veridir, mağazaya özel değil)
apiRouter.use((req, res, next) => {
  if (req.path === "/currencies") return next();
  return verifySessionToken(req, res, next);
});

// Token functions moved to db.js

// Settings functions moved to db.js

// GET /api/currencies
apiRouter.get("/currencies", async (req, res) => {
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
apiRouter.get("/settings", async (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(400).json({ error: "Missing shop" });
  const settings = await getSettings(shop) || {
    currencies: [{ base: "USD", target: "TRY", margin: 0 }],
    autoUpdate: true,
    scheduleTime: "09:00",
    lastUpdated: null,
  };
  res.json(settings);
});

// POST /api/settings
apiRouter.post("/settings", async (req, res) => {
  const shop = resolveShop(req);
  const { currencies, baseCurrency, targets, autoUpdate, scheduleTime, scheduleTimes, rounding, minPrice, rateThreshold, autoPriceNewProducts } = req.body;
  if (!shop) return res.status(400).json({ error: "Missing shop" });

  let currencyList = currencies || [];
  if (baseCurrency && targets && targets.length > 0) {
    currencyList = targets.map(t => ({ base: baseCurrency, target: t.code, margin: t.margin || 0 }));
  }

  const rates = {};
  for (const c of currencyList) {
    try {
      const rate = await getExchangeRate(c.base, c.target);
      rates[`${c.base}_${c.target}`] = rate;
    } catch(e) { console.error(`Rate fetch error:`, e.message); }
  }

  // Mevcut ayarlari koru (lastRates gibi)
  const existing = await getSettings(shop) || {};

  const settings = {
    ...existing,
    currencies: currencyList,
    baseCurrency: baseCurrency || currencyList[0]?.base || "USD",
    targets: targets || currencyList.map(c => ({ code: c.target, margin: c.margin || 0 })),
    autoUpdate: !!autoUpdate,
    scheduleTime: scheduleTime || "09:00",
    scheduleTimes: scheduleTimes || (scheduleTime ? [scheduleTime] : ["09:00"]),
    rounding: rounding || "none",
    minPrice: parseFloat(minPrice) || 0,
    rateThreshold: parseFloat(rateThreshold) || 0,
    autoPriceNewProducts: !!autoPriceNewProducts,
    lastUpdated: existing.lastUpdated || null,
    rates,
  };

  await dbSaveSettings(shop, settings);
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
  const shop = resolveShop(req);
  if (!shop) return res.status(400).json({ error: "Missing shop" });
  const token = await getToken(shop);
  if (!token) return res.status(401).json({ error: "Shop not authenticated" });

  try {
    // GraphQL'de custom/smart ayrımı yok; tek "collections" sorgusu ikisini de getirir
    const query = `
      query Collections($cursor: String) {
        collections(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges { node { id title image { url } } }
        }
      }
    `;

    let edges = [];
    let cursor = null;
    let hasNext = true;
    while (hasNext) {
      const data = await shopifyGraphQL(shop, token, query, { cursor });
      const conn = data?.collections;
      if (!conn) break;
      edges = edges.concat(conn.edges || []);
      hasNext = conn.pageInfo?.hasNextPage;
      cursor = conn.pageInfo?.endCursor;
    }

    const collections = [
      { id: "all", title: "Tüm Ürünler", image: null },
      ...edges.map(({ node: c }) => ({
        id: numericId(c.id),
        title: c.title,
        image: c.image?.url || null,
      })),
    ];

    res.json({ collections });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/products
apiRouter.get("/products", async (req, res) => {
  const shop = resolveShop(req);
  const { collection_id } = req.query;
  if (!shop) return res.status(400).json({ error: "Missing shop" });
  const token = await getToken(shop);
  if (!token) return res.status(401).json({ error: "Shop not authenticated" });

  try {
    // GraphQL ile ürünleri çek (cursor tabanlı sayfalama)
    const inCollection = collection_id && collection_id !== "all";
    let allEdges = [];
    let cursor = null;
    let hasNextPage = true;

    const query = `
      query Products($cursor: String, $query: String) {
        products(first: 100, after: $cursor, query: $query) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              title
              featuredImage { url }
              variants(first: 100) {
                edges {
                  node {
                    id
                    title
                    price
                    compareAtPrice
                  }
                }
              }
            }
          }
        }
      }
    `;

    // Koleksiyon filtresi: GraphQL'de collection_id ile query string kullanılır
    const queryFilter = inCollection
      ? `collection_id:${numericId(collection_id)}`
      : null;

    while (hasNextPage) {
      const data = await shopifyGraphQL(shop, token, query, {
        cursor,
        query: queryFilter,
      });
      const conn = data?.products;
      if (!conn) break;
      allEdges = allEdges.concat(conn.edges || []);
      hasNextPage = conn.pageInfo?.hasNextPage;
      cursor = conn.pageInfo?.endCursor;
    }

    // Çıktıyı eski REST formatıyla birebir aynı tut (frontend değişmesin)
    const products = allEdges.map(({ node: p }) => ({
      id: numericId(p.id),
      title: p.title,
      image: p.featuredImage?.url || null,
      variants: (p.variants?.edges || []).map(({ node: v }) => ({
        id: numericId(v.id),
        title: v.title,
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        usdPrice: v.compareAtPrice || "",
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
  const shop = resolveShop(req);
  const { variantId, usdPrice, baseCurrency, targetCurrency, margin } = req.body;
  if (!shop || !variantId || !usdPrice) return res.status(400).json({ error: "Missing params" });

  const token = await getToken(shop);
  if (!token) return res.status(401).json({ error: "Shop not authenticated" });

  const settings = global.shopSettings[shop];
  const base = baseCurrency || settings?.currencies?.[0]?.base || "USD";
  const target = targetCurrency || settings?.currencies?.[0]?.target || "TRY";
  const marginVal = margin ?? settings?.currencies?.[0]?.margin ?? 0;

  try {
    const rate = await getExchangeRate(base, target);
    const effectiveRate = rate * (1 + marginVal / 100);
    const tryPrice = (parseFloat(usdPrice) * effectiveRate).toFixed(2);

    await updateVariantPrice(
      shop, token, variantId,
      tryPrice,
      parseFloat(usdPrice).toFixed(2),
      req.body.productId || null
    );

    res.json({ success: true, tryPrice, rate: effectiveRate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync
apiRouter.post("/sync", async (req, res) => {
  const shop = resolveShop(req);
  const { collection_id } = req.body;
  if (!shop) return res.status(400).json({ error: "Missing shop" });

  const token = await getToken(shop);
  if (!token) return res.status(401).json({ error: "Shop not authenticated" });

  const settings = await getSettings(shop);
  if (!settings) return res.status(400).json({ error: "No settings configured" });

  try {
    let totalUpdated = 0;
    let lastBatchId = null;
    const productLimit = getProductLimit(shop);

    const rounding = settings.rounding || "none";
    const minPrice = parseFloat(settings.minPrice) || 0;
    const threshold = parseFloat(settings.rateThreshold) || 0; // % eşik

    for (const currencyPair of (settings.currencies || [])) {
      const rate = await getExchangeRate(currencyPair.base, currencyPair.target);
      const effectiveRate = rate * (1 + (currencyPair.margin || 0) / 100);

      // Kur değişim eşiği kontrolü
      const lastRates = settings.lastRates || {};
      const key = `${currencyPair.base}_${currencyPair.target}`;
      const prevRate = lastRates[key];
      if (threshold > 0 && prevRate) {
        const changePct = Math.abs((effectiveRate - prevRate) / prevRate) * 100;
        if (changePct < threshold) {
          console.log(`⏩ ${key}: %${changePct.toFixed(2)} < %${threshold} esik, atlandı`);
          continue;
        }
      }

      console.log(`Sync: ${key}, kur: ${effectiveRate}, yuvarlama: ${rounding}, min: ${minPrice}`);

      const result = collection_id && collection_id !== "all"
        ? await updateCollectionPrices(shop, token, effectiveRate, collection_id, productLimit, { rounding, minPrice })
        : await updateAllProductPrices(shop, token, effectiveRate, productLimit, { rounding, minPrice });

      totalUpdated += result.updatedCount;
      lastBatchId = result.batchId;

      // Son kuru kaydet
      if (!settings.lastRates) settings.lastRates = {};
      settings.lastRates[key] = effectiveRate;
    }

    settings.lastUpdated = new Date().toISOString();
    await dbSaveSettings(shop, settings);

    res.json({ success: true, updatedCount: totalUpdated, batchId: lastBatchId });
  } catch (err) {
    console.error("Sync error:", err);
    res.status(500).json({ error: "Sync failed", details: err.message });
  }
});

// POST /api/preview - degisiklik yapmadan onizleme
apiRouter.post("/preview", async (req, res) => {
  const shop = resolveShop(req);
  const { collection_id } = req.body;
  if (!shop) return res.status(400).json({ error: "Missing shop" });

  const token = await getToken(shop);
  if (!token) return res.status(401).json({ error: "Shop not authenticated" });

  const settings = await getSettings(shop);
  if (!settings) return res.status(400).json({ error: "No settings configured" });

  try {
    const pair = (settings.currencies || [])[0] || { base: "USD", target: "TRY", margin: 0 };
    const rate = await getExchangeRate(pair.base, pair.target);
    const effectiveRate = rate * (1 + (pair.margin || 0) / 100);
    const rounding = settings.rounding || "none";
    const minPrice = parseFloat(settings.minPrice) || 0;

    const result = await previewPrices(shop, token,
      effectiveRate,
      collection_id && collection_id !== "all" ? collection_id : null,
      { rounding, minPrice, limit: 20 });

    res.json({ success: true, ...result, effectiveRate, rounding, minPrice });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history - fiyat degisim gecmisi
apiRouter.get("/history", async (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(400).json({ error: "Missing shop" });
  const history = await getPriceHistory(shop, 100);
  res.json({ history });
});

// GET /api/activity - islem logu
apiRouter.get("/activity", async (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(400).json({ error: "Missing shop" });
  const activity = await getActivityLog(shop, 50);
  res.json({ activity });
});

// POST /api/rollback - son guncellemeyi geri al
apiRouter.post("/rollback", async (req, res) => {
  const shop = resolveShop(req);
  const { batch_id } = req.body;
  if (!shop) return res.status(400).json({ error: "Missing shop" });

  const token = await getToken(shop);
  if (!token) return res.status(401).json({ error: "Shop not authenticated" });

  try {
    let batchId = batch_id;
    if (!batchId) {
      const last = await getLastBatch(shop);
      if (!last) return res.status(400).json({ error: "Geri alınacak işlem yok" });
      batchId = last.batch_id;
    }

    const rows = await getBatchForRollback(shop, batchId);
    if (rows.length === 0) return res.status(400).json({ error: "Geri alınacak veri yok" });

    const result = await rollbackPrices(shop, token, rows);
    res.json({ success: true, restored: result.restored });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pending - USD bekleyen ürünler
apiRouter.get("/pending", async (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(400).json({ error: "Missing shop" });
  const pending = await getPendingProducts(shop);
  res.json({ pending, count: pending.length });
});

// POST /api/pending/resolve - bekleyen ürüne USD ata ve fiyatla
apiRouter.post("/pending/resolve", async (req, res) => {
  const shop = resolveShop(req);
  const { variantId, usdPrice } = req.body;
  if (!shop || !variantId || !usdPrice) return res.status(400).json({ error: "Missing params" });

  const token = await getToken(shop);
  if (!token) return res.status(401).json({ error: "Shop not authenticated" });

  const settings = await getSettings(shop);
  const pair = (settings?.currencies || [])[0] || { base: "USD", target: "TRY", margin: 0 };

  try {
    const rate = await getExchangeRate(pair.base, pair.target);
    const effectiveRate = rate * (1 + (pair.margin || 0) / 100);
    let tryPrice = parseFloat(usdPrice) * effectiveRate;

    // Yuvarlama uygula
    const rounding = settings?.rounding || "none";
    const p = tryPrice;
    if (rounding === "up_99") tryPrice = Math.ceil(p) - 0.01;
    else if (rounding === "up_95") tryPrice = Math.ceil(p) - 0.05;
    else if (rounding === "nearest_int") tryPrice = Math.round(p);
    else if (rounding === "up_int") tryPrice = Math.ceil(p);
    else if (rounding === "nearest_5") tryPrice = Math.round(p/5)*5;
    else if (rounding === "nearest_10") tryPrice = Math.round(p/10)*10;
    tryPrice = tryPrice.toFixed(2);

    const minPrice = parseFloat(settings?.minPrice) || 0;
    if (minPrice > 0) tryPrice = Math.max(parseFloat(tryPrice), minPrice).toFixed(2);

    await updateVariantPrice(
      shop, token, variantId,
      tryPrice,
      parseFloat(usdPrice).toFixed(2),
      req.body.productId || null
    );

    await removePendingProduct(shop, variantId);
    res.json({ success: true, tryPrice });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pending/dismiss - bekleyen üründen çıkar (fiyatlamadan)
apiRouter.post("/pending/dismiss", async (req, res) => {
  const shop = resolveShop(req);
  const { variantId } = req.body;
  if (!shop || !variantId) return res.status(400).json({ error: "Missing params" });
  await removePendingProduct(shop, variantId);
  res.json({ success: true });
});

// GET /api/analytics - analitik veriler
apiRouter.get("/analytics", async (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(400).json({ error: "Missing shop" });

  try {
    const { getActivityLog, getPriceHistory } = await import("./db.js");
    const activity = await getActivityLog(shop, 30);
    const history = await getPriceHistory(shop, 500);

    // Günlük güncelleme sayısı (son 7 gün)
    const dailyUpdates = {};
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      dailyUpdates[key] = 0;
    }
    activity.forEach(a => {
      const key = new Date(a.created_at).toISOString().slice(0, 10);
      if (key in dailyUpdates) dailyUpdates[key] += a.product_count || 0;
    });

    // Kur trendi (history'den unique tarih+rate)
    const rateTrend = [];
    const seenDates = new Set();
    history.forEach(h => {
      const key = new Date(h.created_at).toISOString().slice(0, 13); // saatlik
      if (!seenDates.has(key) && h.rate) {
        seenDates.add(key);
        rateTrend.push({
          time: new Date(h.created_at).toISOString(),
          rate: parseFloat(h.rate),
        });
      }
    });
    rateTrend.sort((a, b) => new Date(a.time) - new Date(b.time));

    // En çok güncellenen ürünler
    const productCounts = {};
    history.forEach(h => {
      if (h.product_title) {
        productCounts[h.product_title] = (productCounts[h.product_title] || 0) + 1;
      }
    });
    const topProducts = Object.entries(productCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([title, count]) => ({ title, count }));

    // Toplam istatistik
    const totalUpdates = activity.reduce((sum, a) => sum + (a.product_count || 0), 0);

    res.json({
      dailyUpdates: Object.entries(dailyUpdates).map(([date, count]) => ({ date, count })),
      rateTrend: rateTrend.slice(-20),
      topProducts,
      totalUpdates,
      totalSyncs: activity.length,
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard
apiRouter.get("/dashboard", async (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(400).json({ error: "Missing shop" });

  const token = await getToken(shop);
  if (!token) return res.status(401).json({ error: "Shop not authenticated" });

  const settings = global.shopSettings[shop] || {};

  try {
    // Ürün sayısı (GraphQL)
    const countData = await shopifyGraphQL(
      shop, token,
      `query { productsCount { count } }`
    );
    const productCount = countData?.productsCount?.count || 0;

    // Güncel kurlar
    const rates = [];
    for (const c of (settings.currencies || [{ base: "USD", target: "TRY", margin: 0 }])) {
      const rate = await getExchangeRate(c.base, c.target);
      const effectiveRate = rate * (1 + (c.margin || 0) / 100);
      rates.push({ base: c.base, target: c.target, rate, effectiveRate, margin: c.margin || 0 });
    }

    const sub = await getSubscription(shop);
    const pendingCount = await countPendingProducts(shop);
    res.json({
      productCount: productCount,
      pendingCount,
      lastUpdated: settings.lastUpdated || null,
      rates,
      autoUpdate: settings.autoUpdate || false,
      scheduleTime: settings.scheduleTime || "09:00",
      plan: sub.plan || "free",
      isPremium: isPremium(shop),
      productLimit: getProductLimit(shop),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});