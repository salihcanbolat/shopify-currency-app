import cron from "node-cron";
import fs from "fs";
import { getExchangeRate } from "./rateService.js";
import { updateAllProductPrices } from "./priceUpdater.js";

function loadTokens() {
  try { return JSON.parse(fs.readFileSync("tokens.json", "utf8")); } catch { return {}; }
}

function loadSettings() {
  try { return JSON.parse(fs.readFileSync("settings.json", "utf8")); } catch { return {}; }
}

export function scheduleCronJob() {
  // Her dakika kontrol et — ayarlanan saatte çalıştır
  cron.schedule("* * * * *", async () => {
    const allSettings = loadSettings();
    const tokens = loadTokens();

    for (const [shop, settings] of Object.entries(allSettings)) {
      if (!settings.autoUpdate) continue;

      const token = tokens[shop];
      if (!token) continue;

      // Zamanlama kontrolü
      const now = new Date();
      const [schedHour, schedMin] = (settings.scheduleTime || "09:00").split(":").map(Number);
      if (now.getHours() !== schedHour || now.getMinutes() !== schedMin) continue;

      console.log(`⏰ Zamanlanmış güncelleme: ${shop} (${settings.scheduleTime})`);

      for (const currencyPair of (settings.currencies || [])) {
        try {
          const rate = await getExchangeRate(currencyPair.base, currencyPair.target);
          const effectiveRate = rate * (1 + (currencyPair.margin || 0) / 100);
          const result = await updateAllProductPrices(shop, token, effectiveRate);
          console.log(`✅ ${shop}: ${result.updatedCount} ürün güncellendi (${currencyPair.base}→${currencyPair.target})`);
        } catch (err) {
          console.error(`❌ ${shop} güncelleme hatası:`, err.message);
        }
      }

      // Son güncelleme zamanını kaydet
      try {
        const all = loadSettings();
        if (all[shop]) {
          all[shop].lastUpdated = new Date().toISOString();
          fs.writeFileSync("settings.json", JSON.stringify(all, null, 2));
        }
      } catch {}
    }
  });

  console.log("⏰ Cron job başlatıldı: dakikalık zamanlama kontrolü aktif");
}