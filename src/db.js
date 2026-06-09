import pg from "pg";
const { Pool } = pg;

let pool = null;

export function getDb() {
  if (!pool) {
    const dbUrl = process.env.DATABASE_URL;
    // Railway internal (.railway.internal) SSL gerektirmez
    // Railway public (.rlwy.net) SSL gerektirir
    const needsSsl = dbUrl && !dbUrl.includes(".railway.internal");
    pool = new Pool({
      connectionString: dbUrl,
      ssl: needsSsl ? { rejectUnauthorized: false } : false,
    });
  }
  return pool;
}

export async function initDb() {
  const db = getDb();
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS shop_tokens (
        shop VARCHAR(255) PRIMARY KEY,
        token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Mevcut tablolara yeni kolonları ekle (eski kurulumlar için)
    await db.query(`ALTER TABLE shop_tokens ADD COLUMN IF NOT EXISTS refresh_token TEXT`);
    await db.query(`ALTER TABLE shop_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS shop_settings (
        shop VARCHAR(255) PRIMARY KEY,
        settings JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS shop_subscriptions (
        shop VARCHAR(255) PRIMARY KEY,
        plan VARCHAR(50) DEFAULT 'free',
        status VARCHAR(50) DEFAULT 'active',
        subscription_id TEXT,
        current_period_end TIMESTAMP,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS price_history (
        id SERIAL PRIMARY KEY,
        shop VARCHAR(255) NOT NULL,
        batch_id VARCHAR(64),
        variant_id VARCHAR(64) NOT NULL,
        product_title TEXT,
        old_price NUMERIC(12,2),
        new_price NUMERIC(12,2),
        usd_price NUMERIC(12,2),
        rate NUMERIC(12,4),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_price_history_shop ON price_history(shop)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_price_history_batch ON price_history(batch_id)`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id SERIAL PRIMARY KEY,
        shop VARCHAR(255) NOT NULL,
        batch_id VARCHAR(64),
        action VARCHAR(50),
        detail TEXT,
        product_count INTEGER DEFAULT 0,
        rate NUMERIC(12,4),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_activity_shop ON activity_log(shop)`);

    // USD fiyat\u0131 bekleyen yeni \u00fcr\u00fcnler
    await db.query(`
      CREATE TABLE IF NOT EXISTS pending_products (
        id SERIAL PRIMARY KEY,
        shop VARCHAR(255) NOT NULL,
        product_id VARCHAR(64) NOT NULL,
        product_title TEXT,
        variant_id VARCHAR(64) NOT NULL,
        variant_title TEXT,
        current_price NUMERIC(12,2),
        image TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(shop, variant_id)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_pending_shop ON pending_products(shop)`);

    console.log("\u2705 Veritaban\u0131 tablolar\u0131 haz\u0131r");
  } catch(e) {
    console.error("❌ Veritabanı init hatası:", e.message);
  }
}

// TOKEN İŞLEMLERİ
// RAM cache artık obje tutar: { token, refreshToken, expiresAt(ms) }
export async function saveToken(shop, token, refreshToken = null, expiresAt = null) {
  const db = getDb();
  await db.query(`
    INSERT INTO shop_tokens (shop, token, refresh_token, expires_at, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (shop) DO UPDATE
      SET token = $2,
          refresh_token = COALESCE($3, shop_tokens.refresh_token),
          expires_at = $4,
          updated_at = NOW()
  `, [shop, token, refreshToken, expiresAt ? new Date(expiresAt) : null]);

  if (!global.shopTokens) global.shopTokens = {};
  global.shopTokens[shop] = { token, refreshToken, expiresAt };
  console.log(`✅ Token DB'ye kaydedildi: ${shop}${expiresAt ? ` (geçerlilik: ${new Date(expiresAt).toISOString()})` : ""}`);
}

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;

// Refresh token ile yeni access token al (Shopify token rotasyonu)
async function refreshAccessToken(shop, refreshToken) {
  console.log(`🔄 Token yenileniyor: ${shop}`);

  // Shopify refresh: application/x-www-form-urlencoded (JSON DEĞİL!)
  const body = new URLSearchParams({
    client_id: SHOPIFY_API_KEY,
    client_secret: SHOPIFY_API_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  async function doRequest() {
    const resp = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: body.toString(),
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`Beklenmeyen yanıt (JSON değil): ${text.slice(0, 120)}`); }
    return { resp, data };
  }

  let resp, data;
  try {
    ({ resp, data } = await doRequest());
  } catch (e) {
    // Tek seferlik retry (Shopify kısa retry penceresi içinde aynı yanıtı dönebilir)
    ({ resp, data } = await doRequest());
  }

  if (!resp.ok || !data.access_token) {
    throw new Error(`Token yenileme başarısız (${resp.status}): ${JSON.stringify(data)}`);
  }

  const newExpiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : null;
  const newRefresh = data.refresh_token || refreshToken;
  await saveToken(shop, data.access_token, newRefresh, newExpiresAt);
  console.log(`✅ Token yenilendi: ${shop} (yeni geçerlilik: ${newExpiresAt ? new Date(newExpiresAt).toISOString() : "yok"})`);
  return data.access_token;
}

// Tek bir mağaza kaydını DB'den oku (RAM'de yoksa)
async function loadTokenRow(shop) {
  const db = getDb();
  const result = await db.query(
    "SELECT token, refresh_token, expires_at FROM shop_tokens WHERE shop = $1",
    [shop]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    token: row.token,
    refreshToken: row.refresh_token || null,
    expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
  };
}

// 401 sonrası zorla yenileme: expiry'ye bakmaz, refresh token varsa hemen yeniler
export async function forceRefreshToken(shop) {
  if (!global.shopTokens) global.shopTokens = {};
  let entry = global.shopTokens[shop];
  if (!entry || typeof entry === "string") {
    try { entry = await loadTokenRow(shop); } catch { entry = null; }
  }
  if (!entry || !entry.refreshToken) {
    console.warn(`forceRefreshToken: ${shop} için refresh token yok`);
    return null;
  }
  try {
    return await refreshAccessToken(shop, entry.refreshToken);
  } catch (e) {
    console.error(`forceRefreshToken hatası (${shop}):`, e.message);
    return null;
  }
}

export async function getToken(shop) {
  if (!global.shopTokens) global.shopTokens = {};

  // RAM'de yoksa DB'den yükle
  let entry = global.shopTokens[shop];
  if (!entry) {
    try {
      entry = await loadTokenRow(shop);
      if (entry) global.shopTokens[shop] = entry;
    } catch (e) {
      console.error("Token DB okuma hatası:", e.message);
    }
  }
  if (!entry || !entry.token) return null;

  // Eski format (sadece string) güvenliği
  if (typeof entry === "string") return entry;

  // Süre dolmaya yakınsa (5 dk eşik) ve refresh varsa proaktif yenile
  const FIVE_MIN = 5 * 60 * 1000;
  const needsRefresh =
    entry.expiresAt && Date.now() > entry.expiresAt - FIVE_MIN;

  if (needsRefresh && entry.refreshToken) {
    try {
      return await refreshAccessToken(shop, entry.refreshToken);
    } catch (e) {
      console.error(`Proaktif token yenileme hatası (${shop}):`, e.message);
      // Token zaten dolmuşsa eski token'ı dönmek 401 verir; null dön ki
      // çağıran taraf yeniden OAuth'a yönlendirsin. Henüz dolmadıysa eldekini dene.
      const stillValid = entry.expiresAt && Date.now() < entry.expiresAt;
      return stillValid ? entry.token : null;
    }
  }

  return entry.token;
}

export async function loadAllTokens() {
  try {
    const db = getDb();
    const result = await db.query(
      "SELECT shop, token, refresh_token, expires_at FROM shop_tokens"
    );
    global.shopTokens = {};
    result.rows.forEach(row => {
      global.shopTokens[row.shop] = {
        token: row.token,
        refreshToken: row.refresh_token || null,
        expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
      };
    });
    console.log(`📦 ${result.rows.length} token DB'den yüklendi`);
  } catch(e) {
    console.error("Token yükleme hatası:", e.message);
    global.shopTokens = {};
  }
}

// AYAR İŞLEMLERİ
export async function saveSettings(shop, settings) {
  const db = getDb();
  await db.query(`
    INSERT INTO shop_settings (shop, settings, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (shop) DO UPDATE SET settings = $2, updated_at = NOW()
  `, [shop, JSON.stringify(settings)]);
  if (!global.shopSettings) global.shopSettings = {};
  global.shopSettings[shop] = settings;
}

export async function getSettings(shop) {
  if (global.shopSettings?.[shop]) return global.shopSettings[shop];
  try {
    const db = getDb();
    const result = await db.query("SELECT settings FROM shop_settings WHERE shop = $1", [shop]);
    if (result.rows.length > 0) {
      const s = result.rows[0].settings;
      if (!global.shopSettings) global.shopSettings = {};
      global.shopSettings[shop] = s;
      return s;
    }
  } catch(e) {
    console.error("Settings DB okuma hatası:", e.message);
  }
  return null;
}

export async function loadAllSettings() {
  try {
    const db = getDb();
    const result = await db.query("SELECT shop, settings FROM shop_settings");
    global.shopSettings = {};
    result.rows.forEach(row => { global.shopSettings[row.shop] = row.settings; });
    console.log(`📦 ${result.rows.length} ayar DB'den yüklendi`);
  } catch(e) {
    console.error("Ayar yükleme hatası:", e.message);
    global.shopSettings = {};
  }
}

// ABONELİK İŞLEMLERİ
export async function saveSubscription(shop, data) {
  const db = getDb();
  await db.query(`
    INSERT INTO shop_subscriptions (shop, plan, status, subscription_id, current_period_end, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (shop) DO UPDATE SET
      plan = $2, status = $3, subscription_id = $4,
      current_period_end = $5, updated_at = NOW()
  `, [shop, data.plan || 'free', data.status || 'active', data.subscriptionId || null, data.currentPeriodEnd || null]);
  if (!global.shopSubscriptions) global.shopSubscriptions = {};
  global.shopSubscriptions[shop] = data;
}

export async function getSubscription(shop) {
  if (global.shopSubscriptions?.[shop]) return global.shopSubscriptions[shop];
  try {
    const db = getDb();
    const result = await db.query("SELECT * FROM shop_subscriptions WHERE shop = $1", [shop]);
    if (result.rows.length > 0) {
      const row = result.rows[0];
      return { plan: row.plan, status: row.status, subscriptionId: row.subscription_id };
    }
  } catch(e) {
    console.error("Subscription DB okuma hatası:", e.message);
  }
  return { plan: "free", status: "active" };
}

// ── FİYAT GEÇMİŞİ ──
export async function logPriceChange(shop, batchId, entry) {
  try {
    const db = getDb();
    await db.query(`
      INSERT INTO price_history (shop, batch_id, variant_id, product_title, old_price, new_price, usd_price, rate)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [shop, batchId, entry.variantId, entry.productTitle || null,
        entry.oldPrice || null, entry.newPrice, entry.usdPrice, entry.rate]);
  } catch(e) {
    console.error("Price history log hatası:", e.message);
  }
}

export async function getPriceHistory(shop, limit = 100) {
  try {
    const db = getDb();
    const result = await db.query(`
      SELECT * FROM price_history WHERE shop = $1
      ORDER BY created_at DESC LIMIT $2
    `, [shop, limit]);
    return result.rows;
  } catch(e) {
    console.error("Price history okuma hatası:", e.message);
    return [];
  }
}

// ── İŞLEM LOGU ──
export async function logActivity(shop, batchId, action, detail, productCount, rate) {
  try {
    const db = getDb();
    await db.query(`
      INSERT INTO activity_log (shop, batch_id, action, detail, product_count, rate)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [shop, batchId, action, detail || null, productCount || 0, rate || null]);
  } catch(e) {
    console.error("Activity log hatası:", e.message);
  }
}

export async function getActivityLog(shop, limit = 50) {
  try {
    const db = getDb();
    const result = await db.query(`
      SELECT * FROM activity_log WHERE shop = $1
      ORDER BY created_at DESC LIMIT $2
    `, [shop, limit]);
    return result.rows;
  } catch(e) {
    return [];
  }
}

// ── GERİ ALMA (ROLLBACK) ──
// Bir batch'teki tüm fiyatları eski haline döndürmek için geçmişi getir
export async function getBatchForRollback(shop, batchId) {
  try {
    const db = getDb();
    const result = await db.query(`
      SELECT variant_id, old_price FROM price_history
      WHERE shop = $1 AND batch_id = $2 AND old_price IS NOT NULL
    `, [shop, batchId]);
    return result.rows;
  } catch(e) {
    console.error("Rollback veri okuma hatası:", e.message);
    return [];
  }
}

// Son batch_id'yi bul (en son güncelleme)
export async function getLastBatch(shop) {
  try {
    const db = getDb();
    const result = await db.query(`
      SELECT batch_id, MAX(created_at) as ts, COUNT(*) as cnt
      FROM price_history WHERE shop = $1 AND batch_id IS NOT NULL
      GROUP BY batch_id ORDER BY ts DESC LIMIT 1
    `, [shop]);
    return result.rows[0] || null;
  } catch(e) {
    return null;
  }
}

// ── BEKLEYEN ÜRÜNLER (USD girilmemiş) ──
export async function addPendingProduct(shop, p) {
  try {
    const db = getDb();
    await db.query(`
      INSERT INTO pending_products (shop, product_id, product_title, variant_id, variant_title, current_price, image)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (shop, variant_id) DO UPDATE SET
        product_title = $3, variant_title = $5, current_price = $6, image = $7
    `, [shop, p.productId, p.productTitle, p.variantId, p.variantTitle, p.currentPrice || null, p.image || null]);
  } catch(e) {
    console.error("Pending ürün ekleme hatası:", e.message);
  }
}

export async function getPendingProducts(shop) {
  try {
    const db = getDb();
    const result = await db.query(`
      SELECT * FROM pending_products WHERE shop = $1 ORDER BY created_at DESC
    `, [shop]);
    return result.rows;
  } catch(e) {
    return [];
  }
}

export async function removePendingProduct(shop, variantId) {
  try {
    const db = getDb();
    await db.query(`DELETE FROM pending_products WHERE shop = $1 AND variant_id = $2`, [shop, variantId]);
  } catch(e) {
    console.error("Pending ürün silme hatası:", e.message);
  }
}

export async function countPendingProducts(shop) {
  try {
    const db = getDb();
    const result = await db.query(`SELECT COUNT(*) as cnt FROM pending_products WHERE shop = $1`, [shop]);
    return parseInt(result.rows[0]?.cnt || 0);
  } catch(e) {
    return 0;
  }
}

// GDPR shop/redact: bir mağazaya ait tüm verileri sil
export async function deleteShopData(shop) {
  const db = getDb();
  const tables = ["shop_tokens", "shop_settings", "shop_subscriptions", "price_history", "activity_log", "pending_products"];
  for (const t of tables) {
    try {
      await db.query(`DELETE FROM ${t} WHERE shop = $1`, [shop]);
    } catch (e) {
      console.error(`deleteShopData ${t} hatası:`, e.message);
    }
  }
  console.log(`🗑️ Mağaza verileri silindi (GDPR): ${shop}`);
}