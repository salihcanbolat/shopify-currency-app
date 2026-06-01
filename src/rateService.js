// Rate cache: { "USD_TRY": { rate: 32.5, fetchedAt: Date } }
const rateCache = {};
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function getExchangeRate(base, target) {
  if (base === target) return 1;

  const cacheKey = `${base}_${target}`;
  const cached = rateCache[cacheKey];

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    console.log(`📦 Cache hit: ${cacheKey} = ${cached.rate}`);
    return cached.rate;
  }

  try {
    // Free API — no key required for basic use
    // In production, use paid tier: exchangerate-api.com or fixer.io
    const url = `https://open.er-api.com/v6/latest/${base}`;
    const response = await fetch(url);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();

    if (!data.rates || !data.rates[target]) {
      throw new Error(`Target currency ${target} not found in response`);
    }

    const rate = data.rates[target];

    rateCache[cacheKey] = { rate, fetchedAt: Date.now() };
    console.log(`✅ Rate fetched: 1 ${base} = ${rate} ${target}`);

    return rate;
  } catch (err) {
    console.error(`❌ Rate fetch error: ${err.message}`);

    // Return cached value even if stale, rather than crashing
    if (cached) {
      console.warn(`⚠️  Using stale cache for ${cacheKey}`);
      return cached.rate;
    }

    throw err;
  }
}

export function clearRateCache() {
  Object.keys(rateCache).forEach((k) => delete rateCache[k]);
}
