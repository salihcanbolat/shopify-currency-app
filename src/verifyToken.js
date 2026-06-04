import jwt from "jsonwebtoken";

const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;

/**
 * Shopify session token (JWT) doğrulama middleware'i.
 *
 * Embedded app, App Bridge ile her API isteğinde
 * Authorization: Bearer <token> header'ı gönderir.
 * Bu token Shopify tarafından imzalanır; biz API secret ile doğrularız.
 *
 * Token geçerliyse, içinden mağaza adını çıkarıp req.shop'a koyarız.
 * Böylece istemcinin gönderdiği "shop" parametresine körü körüne güvenmeyiz.
 */
export function verifySessionToken(req, res, next) {
  // Geliştirme/geçiş kolaylığı: token yoksa ve ortam izin veriyorsa eski davranış
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    // Token yoksa: güvenli tarafta kal, 401 dön.
    // (Geçiş döneminde ALLOW_NO_TOKEN=true ile gevşetilebilir.)
    if (process.env.ALLOW_NO_TOKEN === "true") {
      return next();
    }
    return res.status(401).json({ error: "Oturum doğrulanamadı (token yok)" });
  }

  try {
    // Shopify session token HS256 ile imzalanır, secret = API secret
    const payload = jwt.verify(token, SHOPIFY_API_SECRET, {
      algorithms: ["HS256"],
    });

    // aud (audience) bizim API key'imiz olmalı
    if (payload.aud !== SHOPIFY_API_KEY) {
      return res.status(401).json({ error: "Token hedefi geçersiz" });
    }

    // dest alanı mağaza URL'sidir: "https://magaza.myshopify.com"
    const dest = payload.dest || "";
    const shop = dest.replace("https://", "").replace("http://", "");

    if (!shop || !shop.endsWith(".myshopify.com")) {
      return res.status(401).json({ error: "Token içinde geçerli mağaza yok" });
    }

    // Doğrulanmış mağazayı request'e ekle
    req.shop = shop;
    req.shopifyToken = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Oturum doğrulanamadı: " + err.message });
  }
}

/**
 * Yardımcı: doğrulanmış shop'u al.
 * Token varsa req.shop'u, yoksa (geçiş modunda) query/body'deki shop'u döner.
 */
export function resolveShop(req) {
  if (req.shop) return req.shop;
  return req.query.shop || req.body?.shop || null;
}