// Ortak GraphQL Admin API istemcisi.
// Tüm Shopify Admin API çağrıları buradan geçer; API sürümü tek yerde tanımlı.

export const API_VERSION = "2026-04";

/**
 * Shopify GraphQL Admin API'ye istek atar.
 * @param {string} shop  - "magaza.myshopify.com"
 * @param {string} token - geçerli (gerekirse yenilenmiş) access token
 * @param {string} query - GraphQL query/mutation
 * @param {object} variables - GraphQL değişkenleri
 * @returns {Promise<object>} data.data (userErrors kontrolü çağırana bırakılır)
 */
export async function shopifyGraphQL(shop, token, query, variables = {}) {
  const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await response.json();

  // Üst seviye GraphQL hataları (sözdizimi, yetki, throttle vb.)
  if (json.errors) {
    throw new Error("[GraphQL] " + JSON.stringify(json.errors));
  }
  return json.data;
}

/**
 * Shopify global ID'sinden sayısal ID çıkarır.
 * "gid://shopify/Product/12345" -> "12345"
 */
export function numericId(gid) {
  if (!gid) return null;
  const parts = String(gid).split("/");
  return parts[parts.length - 1];
}

/**
 * Sayısal ID'yi Shopify global ID'ye çevirir.
 * ("Product", "12345") -> "gid://shopify/Product/12345"
 */
export function toGid(type, id) {
  if (String(id).startsWith("gid://")) return id;
  return `gid://shopify/${type}/${id}`;
}

/**
 * Tek bir variant'ın fiyatını ve compareAtPrice'ını günceller.
 * GraphQL productVariantsBulkUpdate, owner product ID gerektirir;
 * verilmemişse variant'tan sorgulanır.
 * @returns {Promise<void>} hata olursa throw eder
 */
export async function updateVariantPrice(shop, token, variantId, price, compareAtPrice, productId = null) {
  const variantGid = toGid("ProductVariant", variantId);

  // Owner product ID yoksa variant'tan çek
  let productGid = productId ? toGid("Product", productId) : null;
  if (!productGid) {
    const q = `query($id: ID!){ productVariant(id:$id){ product{ id } } }`;
    const d = await shopifyGraphQL(shop, token, q, { id: variantGid });
    productGid = d?.productVariant?.product?.id;
    if (!productGid) throw new Error("Variant'ın ürünü bulunamadı: " + variantId);
  }

  const mutation = `
    mutation BulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        userErrors { field message }
      }
    }
  `;
  const variantInput = { id: variantGid, price: String(price) };
  // compareAtPrice yalnızca açıkça verilmişse gönderilir (null geçilirse mevcut değer korunur)
  if (compareAtPrice != null) {
    variantInput.compareAtPrice = String(compareAtPrice);
  }
  const variants = [variantInput];

  const data = await shopifyGraphQL(shop, token, mutation, { productId: productGid, variants });
  const errs = data?.productVariantsBulkUpdate?.userErrors;
  if (errs && errs.length) {
    throw new Error("[Variant update] " + errs.map(e => e.message).join("; "));
  }
}