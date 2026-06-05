import crypto from "crypto";
import { logPriceChange, logActivity } from "./db.js";
import { shopifyGraphQL, numericId, updateVariantPrice } from "./graphql.js";

const DELAY_MS = 300;

// Yuvarlama uygula
function applyRounding(price, rule) {
  const p = parseFloat(price);
  switch(rule) {
    case "up_99":      // 299.99
      return (Math.ceil(p) - 0.01).toFixed(2);
    case "up_95":      // 299.95
      return (Math.ceil(p) - 0.05).toFixed(2);
    case "nearest_int": // 300
      return Math.round(p).toFixed(2);
    case "up_int":     // yukarı yuvarla 300
      return Math.ceil(p).toFixed(2);
    case "nearest_5":  // en yakın 5'e
      return (Math.round(p / 5) * 5).toFixed(2);
    case "nearest_10": // en yakın 10'a
      return (Math.round(p / 10) * 10).toFixed(2);
    default:           // none
      return p.toFixed(2);
  }
}

// Minimum kâr koruması: hesaplanan fiyat min fiyatın altındaysa min'i kullan
function applyMinPrice(price, minPrice) {
  if (!minPrice || minPrice <= 0) return price;
  return Math.max(parseFloat(price), parseFloat(minPrice)).toFixed(2);
}

export async function updateAllProductPrices(shop, accessToken, effectiveRate, limit = Infinity, options = {}) {
  return await updateProducts(shop, accessToken, effectiveRate, null, limit, options);
}

export async function updateCollectionPrices(shop, accessToken, effectiveRate, collectionId, limit = Infinity, options = {}) {
  return await updateProducts(shop, accessToken, effectiveRate, collectionId, limit, options);
}

async function fetchAllVariants(shop, accessToken, collectionId) {
  // GraphQL ile ürünleri + variant'ları çek. Çıktı eski REST formatına uygun:
  // [{ id, title, variants: [{ id, title, price, compare_at_price }] }]
  const query = `
    query Products($cursor: String, $query: String) {
      products(first: 100, after: $cursor, query: $query) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            variants(first: 100) {
              edges { node { id title price compareAtPrice } }
            }
          }
        }
      }
    }
  `;
  const queryFilter = collectionId ? `collection_id:${numericId(collectionId)}` : null;

  let allProducts = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await shopifyGraphQL(shop, accessToken, query, { cursor, query: queryFilter });
    const conn = data?.products;
    if (!conn) break;
    for (const { node: p } of (conn.edges || [])) {
      allProducts.push({
        id: numericId(p.id),
        title: p.title,
        variants: (p.variants?.edges || []).map(({ node: v }) => ({
          id: numericId(v.id),
          title: v.title,
          price: v.price,
          compare_at_price: v.compareAtPrice,
        })),
      });
    }
    hasNextPage = conn.pageInfo?.hasNextPage;
    cursor = conn.pageInfo?.endCursor;
  }
  return allProducts;
}

async function updateProducts(shop, accessToken, effectiveRate, collectionId, limit = Infinity, options = {}) {
  const {
    rounding = "none",
    minPrice = 0,
    batchId = crypto.randomBytes(8).toString("hex"),
    log = true,
  } = options;

  const allProducts = await fetchAllVariants(shop, accessToken, collectionId);

  // Ürün başlığını + ürün ID'sini variant'a bağla
  const variantList = [];
  allProducts.forEach(p => {
    p.variants.forEach(v => variantList.push({ ...v, productTitle: p.title, productId: p.id }));
  });

  const limited = isFinite(limit) ? variantList.slice(0, limit) : variantList;
  let totalUpdated = 0;

  for (const variant of limited) {
    try {
      const usdPrice = variant.compare_at_price
        ? parseFloat(variant.compare_at_price)
        : parseFloat(variant.price);

      if (!usdPrice || usdPrice <= 0) continue;

      let tryPrice = usdPrice * effectiveRate;
      tryPrice = applyRounding(tryPrice, rounding);
      tryPrice = applyMinPrice(tryPrice, minPrice);

      const oldPrice = variant.price;

      await updateVariantPrice(
        shop, accessToken, variant.id,
        tryPrice,
        usdPrice.toFixed(2),
        variant.productId
      );
      totalUpdated++;
      if (log) {
        await logPriceChange(shop, batchId, {
          variantId: variant.id,
          productTitle: variant.productTitle,
          oldPrice,
          newPrice: tryPrice,
          usdPrice,
          rate: effectiveRate,
        });
      }

      if (totalUpdated % 5 === 0) await sleep(300);
    } catch(err) {
      console.error(`Variant ${variant.id} hata:`, err.message);
    }
  }

  if (log) {
    await logActivity(shop, batchId, "sync",
      collectionId ? `Koleksiyon güncellendi` : `Tüm ürünler güncellendi`,
      totalUpdated, effectiveRate);
  }

  return { updatedCount: totalUpdated, batchId };
}

// ── ÖNİZLEME: değişiklik yapmadan ne olacağını hesapla ──
export async function previewPrices(shop, accessToken, effectiveRate, collectionId, options = {}) {
  const { rounding = "none", minPrice = 0, limit = 20 } = options;
  const allProducts = await fetchAllVariants(shop, accessToken, collectionId);

  const preview = [];
  let count = 0;

  for (const p of allProducts) {
    for (const v of p.variants) {
      if (count >= limit) break;
      const usdPrice = v.compare_at_price ? parseFloat(v.compare_at_price) : parseFloat(v.price);
      if (!usdPrice || usdPrice <= 0) continue;

      let newPrice = usdPrice * effectiveRate;
      newPrice = applyRounding(newPrice, rounding);
      newPrice = applyMinPrice(newPrice, minPrice);

      preview.push({
        productTitle: p.title,
        variantTitle: v.title,
        oldPrice: v.price,
        newPrice,
        usdPrice: usdPrice.toFixed(2),
      });
      count++;
    }
    if (count >= limit) break;
  }

  // Toplam etkilenecek ürün sayısı
  const totalVariants = allProducts.reduce((sum, p) => sum + p.variants.length, 0);

  return { preview, totalVariants };
}

// ── GERİ ALMA: eski fiyatlara döndür ──
export async function rollbackPrices(shop, accessToken, rows) {
  let restored = 0;
  for (const row of rows) {
    try {
      // compareAtPrice null geçilince değişmez; sadece fiyatı eski haline al
      await updateVariantPrice(shop, accessToken, row.variant_id, row.old_price, null, null);
      restored++;
      if (restored % 5 === 0) await sleep(300);
    } catch(e) {
      console.error(`Rollback ${row.variant_id} hata:`, e.message);
    }
  }
  return { restored };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }