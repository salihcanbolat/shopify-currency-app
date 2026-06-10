// Kur servisi — çok katmanlı, dayanıklı.
// 1) Bellek cache (6 saat)
// 2) Birincil API: fawazahmed/exchange-api (jsDelivr CDN) — limitsiz, 200+ para birimi
//    1b) jsDelivr çökerse pages.dev mirror
// 3) Yedek API: open.er-api.com
// 4) Hepsi başarısızsa: DB'deki son bilinen kur (stale)
// getExchangeRate(base, target) arayüzü değişmez.

import { saveRateToDb, getRateFromDb } from "./db.js";

const rateCache = {}; // { "USD_TRY": { rate, fetchedAt } }
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 saat

const FETCH_TIMEOUT_MS = 8000;

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Birincil: fawazahmed (küçük harf kodlar, base obje içinde) ──
// Örn: https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json
//      -> { date, usd: { try: 34.1, eur: 0.92, ... } }
async function fetchPrimary(base, target) {
  const b = base.toLowerCase();
  const t = target.toLowerCase();
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${b}.min.json`,
    `https://latest.currency-api.pages.dev/v1/currencies/${b}.min.json`,
  ];
  let lastErr;
  for (const url of urls) {
    try {
      const data = await fetchJson(url);
      const rate = data && data[b] && data[b][t];
      if (typeof rate === "number" && rate > 0) return rate;
      throw new Error(`Hedef ${target} bulunamadı`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Birincil API başarısız");
}

// ── Yedek: open.er-api.com (büyük harf kodlar, rates obje içinde) ──
async function fetchFallback(base, target) {
  const data = await fetchJson(`https://open.er-api.com/v6/latest/${base}`);
  const rate = data && data.rates && data.rates[target];
  if (typeof rate === "number" && rate > 0) return rate;
  throw new Error(`Yedek API: hedef ${target} bulunamadı`);
}

export async function getExchangeRate(base, target) {
  if (base === target) return 1;

  const cacheKey = `${base}_${target}`;
  const cached = rateCache[cacheKey];

  // 1) Taze bellek cache
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.rate;
  }

  // 2) Birincil API
  try {
    const rate = await fetchPrimary(base, target);
    rateCache[cacheKey] = { rate, fetchedAt: Date.now() };
    await saveRateToDb(cacheKey, rate, "fawazahmed");
    console.log(`✅ Kur (birincil): 1 ${base} = ${rate} ${target}`);
    return rate;
  } catch (e1) {
    console.warn(`⚠️ Birincil API başarısız (${cacheKey}): ${e1.message} — yedeğe geçiliyor`);
  }

  // 3) Yedek API
  try {
    const rate = await fetchFallback(base, target);
    rateCache[cacheKey] = { rate, fetchedAt: Date.now() };
    await saveRateToDb(cacheKey, rate, "open.er-api");
    console.log(`✅ Kur (yedek): 1 ${base} = ${rate} ${target}`);
    return rate;
  } catch (e2) {
    console.error(`❌ Yedek API de başarısız (${cacheKey}): ${e2.message}`);
  }

  // 4) Bellekteki stale değer
  if (cached) {
    console.warn(`⚠️ Stale bellek cache kullanılıyor: ${cacheKey}`);
    return cached.rate;
  }

  // 5) DB'deki son bilinen kur (deploy sonrası bellek boşsa)
  const dbRate = await getRateFromDb(cacheKey);
  if (dbRate) {
    console.warn(`⚠️ DB stale cache kullanılıyor: ${cacheKey} (${new Date(dbRate.fetchedAt).toISOString()})`);
    rateCache[cacheKey] = { rate: dbRate.rate, fetchedAt: dbRate.fetchedAt };
    return dbRate.rate;
  }

  throw new Error(`Kur alınamadı ve önbellek yok: ${cacheKey}`);
}

export function clearRateCache() {
  Object.keys(rateCache).forEach((k) => delete rateCache[k]);
}