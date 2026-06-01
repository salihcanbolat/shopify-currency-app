const BATCH_SIZE = 50;
const DELAY_MS = 300;

export async function updateAllProductPrices(shop, accessToken, effectiveRate) {
  let cursor = null;
  let hasNextPage = true;
  let totalUpdated = 0;

  while (hasNextPage) {
    const { variants, pageInfo } = await fetchVariantBatch(shop, accessToken, cursor);
    if (variants.length === 0) break;

    for (const variant of variants) {
      try {
        const usdPrice = variant.compareAtPrice
          ? parseFloat(variant.compareAtPrice)
          : parseFloat(variant.price);

        if (!usdPrice || usdPrice <= 0) continue;

        const tryPrice = (usdPrice * effectiveRate).toFixed(2);

        console.log(`Variant ${variant.id}: USD=${usdPrice}, TRY=${tryPrice}`);

        // REST API ile güncelle
        const response = await fetch(
          `https://${shop}/admin/api/2024-01/variants/${variant.id}.json`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": accessToken,
            },
            body: JSON.stringify({
              variant: {
                id: variant.id,
                price: tryPrice,
                compare_at_price: usdPrice.toFixed(2),
              },
            }),
          }
        );

        const result = await response.json();

        if (result.errors) {
          console.error(`Variant ${variant.id} hata:`, JSON.stringify(result.errors));
          continue;
        }

        if (result.variant) {
          console.log(`✅ Variant ${variant.id} güncellendi: ₺${result.variant.price}`);
          totalUpdated++;
        }

        if (totalUpdated % 5 === 0) await sleep(300);

      } catch (err) {
        console.error(`Variant ${variant.id} hata:`, err.message);
      }
    }

    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
    if (hasNextPage) await sleep(DELAY_MS);
  }

  console.log(`Toplam güncellenen: ${totalUpdated}`);
  return { updatedCount: totalUpdated };
}

async function fetchVariantBatch(shop, accessToken, cursor) {
  const query = `
    query getVariants($cursor: String) {
      productVariants(first: ${BATCH_SIZE}, after: $cursor) {
        nodes {
          id
          price
          compareAtPrice
          product { title }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const response = await fetch(
    `https://${shop}/admin/api/2024-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables: { cursor: cursor || null } }),
    }
  );

  const data = await response.json();

  // GraphQL hata verirse REST API ile dene
  if (data.errors || !data.data) {
    console.log("GraphQL hata, REST API ile deneniyor...");
    return await fetchVariantBatchREST(shop, accessToken, cursor);
  }

  const nodes = data.data?.productVariants?.nodes || [];
  const pageInfo = data.data?.productVariants?.pageInfo || { hasNextPage: false };

  // GID'den sayısal ID çıkar
  const variants = nodes.map(v => ({
    id: v.id.replace("gid://shopify/ProductVariant/", ""),
    price: v.price,
    compareAtPrice: v.compareAtPrice,
  }));

  return { variants, pageInfo };
}

async function fetchVariantBatchREST(shop, accessToken, cursor) {
  // REST API ile ürünleri çek
  const url = `https://${shop}/admin/api/2024-01/products.json?limit=${BATCH_SIZE}&fields=id,variants`;
  const response = await fetch(url, {
    headers: { "X-Shopify-Access-Token": accessToken },
  });
  const data = await response.json();

  const variants = [];
  (data.products || []).forEach(p => {
    p.variants.forEach(v => {
      variants.push({
        id: v.id,
        price: v.price,
        compareAtPrice: v.compare_at_price,
      });
    });
  });

  return { variants, pageInfo: { hasNextPage: false } };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}