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

    console.log("✅ Veritabanı tabloları hazır");
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