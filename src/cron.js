import cron from "node-cron";
import { getExchangeRate } from "./rateService.js";
import { updateAllProductPrices } from "./priceUpdater.js";
import { getToken } from "./db.js";

export function scheduleCronJob() {
  cron.schedule("* * * * *", async () => {
    const allSettings = global.shopSettings || {};
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;

    for (const [shop, settings] of Object.entries(allSettings)) {
      if (!settings.autoUpdate) continue;
      // getToken refresh'i de hallediyor (süresi dolmuşsa yeniler)
      const token = await getToken(shop);
      if (!token) continue;

      // Çoklu zamanlama desteği — scheduleTimes dizisi veya tek scheduleTime
      const times = settings.scheduleTimes && settings.scheduleTimes.length > 0
        ? settings.scheduleTimes
        : [settings.scheduleTime || "09:00"];

      if (!times.includes(currentTime)) continue;

      console.log(`⏰ Zamanlanmış güncelleme: ${shop} (${currentTime})`);

      const rounding = settings.rounding || "none";
      const minPrice = parseFloat(settings.minPrice) || 0;
      const threshold = parseFloat(settings.rateThreshold) || 0;

      for (const currencyPair of (settings.currencies || [])) {
        try {
          const rate = await getExchangeRate(currencyPair.base, currencyPair.target);
          const effectiveRate = rate * (1 + (currencyPair.margin || 0) / 100);

          // Eşik kontrolü
          const key = `${currencyPair.base}_${currencyPair.target}`;
          const lastRates = settings.lastRates || {};
          const prevRate = lastRates[key];
          if (threshold > 0 && prevRate) {
            const changePct = Math.abs((effectiveRate - prevRate) / prevRate) * 100;
            if (changePct < threshold) {
              console.log(`⏩ ${key}: %${changePct.toFixed(2)} < %${threshold}, atlandı`);
              continue;
            }
          }

          const result = await updateAllProductPrices(shop, token, effectiveRate, Infinity, { rounding, minPrice });
          console.log(`✅ ${shop}: ${result.updatedCount} ürün güncellendi (${key})`);

          if (!settings.lastRates) settings.lastRates = {};
          settings.lastRates[key] = effectiveRate;
        } catch(err) {
          console.error(`❌ ${shop} hata:`, err.message);
        }
      }

      if (global.shopSettings?.[shop]) {
        global.shopSettings[shop].lastUpdated = new Date().toISOString();
      }
    }
  });

  console.log("⏰ Cron job başlatıldı: dakikalık zamanlama kontrolü aktif");
}