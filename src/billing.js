import { API_VERSION } from "./graphql.js";

const HOST = process.env.HOST || "https://shopify-currency-app-production.up.railway.app";
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;

export const PLANS = {
  free: {
    name: "Free",
    price: 0,
    productLimit: 50,
    features: ["50 ürüne kadar", "Manuel senkronizasyon", "1 kur çifti"],
  },
  premium: {
    name: "Premium",
    price: 4.99,
    productLimit: Infinity,
    features: ["Sınırsız ürün", "Otomatik senkronizasyon", "Çoklu kur çifti", "Koleksiyon bazlı güncelleme", "Zamanlama"],
  },
};

export function isPremium(shop) {
  const sub = global.shopSubscriptions?.[shop];
  return sub?.plan === "premium" && sub?.status === "active";
}

export function getProductLimit(shop) {
  return isPremium(shop) ? Infinity : PLANS.free.productLimit;
}

// Shopify'da ücretli abonelik oluştur
export async function createSubscription(shop, token) {
  const mutation = `
    mutation {
      appSubscriptionCreate(
        name: "KurSync Premium"
        returnUrl: "${HOST}/billing/confirm?shop=${shop}"
        test: ${process.env.NODE_ENV !== "production"}
        lineItems: [{
          plan: {
            appRecurringPricingDetails: {
              price: { amount: 4.99, currencyCode: USD }
              interval: EVERY_30_DAYS
            }
          }
        }]
      ) {
        appSubscription { id status }
        confirmationUrl
        userErrors { field message }
      }
    }
  `;

  const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query: mutation }),
  });

  const data = await response.json();
  const result = data.data?.appSubscriptionCreate;

  if (result?.userErrors?.length > 0) {
    throw new Error(result.userErrors[0].message);
  }

  return {
    confirmationUrl: result?.confirmationUrl,
    subscriptionId: result?.appSubscription?.id,
  };
}

// Aktif aboneliği kontrol et
export async function checkSubscription(shop, token) {
  const query = `
    {
      currentAppInstallation {
        activeSubscriptions {
          id
          name
          status
          currentPeriodEnd
          lineItems {
            plan {
              pricingDetails {
                ... on AppRecurringPricing {
                  price { amount currencyCode }
                  interval
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query }),
  });

  const data = await response.json();
  const subs = data.data?.currentAppInstallation?.activeSubscriptions || [];

  if (subs.length > 0 && subs[0].status === "ACTIVE") {
    const subData = {
      plan: "premium",
      status: "active",
      subscriptionId: subs[0].id,
      currentPeriodEnd: subs[0].currentPeriodEnd,
    };
    if (!global.shopSubscriptions) global.shopSubscriptions = {};
    global.shopSubscriptions[shop] = subData;
    return subData;
  }

  const freeData = { plan: "free", status: "active" };
  if (!global.shopSubscriptions) global.shopSubscriptions = {};
  global.shopSubscriptions[shop] = freeData;
  return freeData;
}