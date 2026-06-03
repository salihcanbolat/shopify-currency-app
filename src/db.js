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
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

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

    console.log("\u2705 Veritaban\u0131 tablolar\u0131 haz\u0131r");
  } catch(e) {
    console.error("❌ Veritabanı init hatası:", e.message);
  }
}

// TOKEN İŞLEMLERİ
export async function saveToken(shop, token) {
  const db = getDb();
  await db.query(`
    INSERT INTO shop_tokens (shop, token, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (shop) DO UPDATE SET token = $2, updated_at = NOW()
  `, [shop, token]);
  if (!global.shopTokens) global.shopTokens = {};
  global.shopTokens[shop] = token;
  console.log(`✅ Token DB'ye kaydedildi: ${shop}`);
}

export async function getToken(shop) {
  // Önce RAM'den kontrol et
  if (global.shopTokens?.[shop]) return global.shopTokens[shop];

  // Env variable'dan kontrol et
  const envKey = "SHOP_TOKEN_" + shop.replace(/[^a-zA-Z0-9]/g, "_");
  if (process.env[envKey]) return process.env[envKey];

  // DB'den oku
  try {
    const db = getDb();
    const result = await db.query("SELECT token FROM shop_tokens WHERE shop = $1", [shop]);
    if (result.rows.length > 0) {
      const token = result.rows[0].token;
      if (!global.shopTokens) global.shopTokens = {};
      global.shopTokens[shop] = token;
      return token;
    }
  } catch(e) {
    console.error("Token DB okuma hatası:", e.message);
  }

  return null;
}

export async function loadAllTokens() {
  try {
    const db = getDb();
    const result = await db.query("SELECT shop, token FROM shop_tokens");
    global.shopTokens = {};
    result.rows.forEach(row => { global.shopTokens[row.shop] = row.token; });
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