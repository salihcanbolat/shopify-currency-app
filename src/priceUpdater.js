const DELAY_MS = 300;

export async function updateAllProductPrices(shop, accessToken, effectiveRate, limit = Infinity) {
  return await updateProducts(shop, accessToken, effectiveRate, null, limit);
}

export async function updateCollectionPrices(shop, accessToken, effectiveRate, collectionId, limit = Infinity) {
  return await updateProducts(shop, accessToken, effectiveRate, collectionId, limit);
}

async function updateProducts(shop, accessToken, effectiveRate, collectionId, limit = Infinity) {
  let allProducts = [];
  let pageInfo = null;
  let hasNextPage = true;

  while (hasNextPage) {
    let url;
    if (collectionId) {
      url = pageInfo
        ? `https://${shop}/admin/api/2024-01/products.json?limit=250&page_info=${pageInfo}`
        : `https://${shop}/admin/api/2024-01/products.json?limit=250&fields=id,variants&collection_id=${collectionId}`;
    } else {
      url = pageInfo
        ? `https://${shop}/admin/api/2024-01/products.json?limit=250&page_info=${pageInfo}`
        : `https://${shop}/admin/api/2024-01/products.json?limit=250&fields=id,variants`;
    }

    const response = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
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

  let totalUpdated = 0;
  const variants = allProducts.flatMap(p => p.variants);

  // Free plan limiti uygula
  const limitedVariants = isFinite(limit) ? variants.slice(0, limit) : variants;
  if (isFinite(limit) && variants.length > limit) {
    console.log(`⚠️ Free plan limiti: ${variants.length} varyant var, ${limit} tanesi güncellenecek`);
  }

  for (const variant of limitedVariants) {
    try {
      const usdPrice = variant.compare_at_price
        ? parseFloat(variant.compare_at_price)
        : parseFloat(variant.price);

      if (!usdPrice || usdPrice <= 0) continue;

      const tryPrice = (usdPrice * effectiveRate).toFixed(2);

      const response = await fetch(`https://${shop}/admin/api/2024-01/variants/${variant.id}.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
        body: JSON.stringify({ variant: { id: variant.id, price: tryPrice, compare_at_price: usdPrice.toFixed(2) } }),
      });

      const result = await response.json();
      if (result.variant) {
        totalUpdated++;
        console.log(`✅ ${variant.id}: ₺${result.variant.price}`);
      }

      if (totalUpdated % 5 === 0) await sleep(300);
    } catch (err) {
      console.error(`Variant ${variant.id} hata:`, err.message);
    }
  }

  return { updatedCount: totalUpdated };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }