import cron from "node-cron";
import { getExchangeRate } from "./rateService.js";
import { updateAllProductPrices } from "./priceUpdater.js";

export function scheduleCronJob() {
  // Run every hour at :00
  cron.schedule("0 * * * *", async () => {
    console.log("⏰ Cron: Running scheduled currency sync...");

    const shops = Object.keys(global.shopSettings || {});

    for (const shop of shops) {
      const settings = global.shopSettings[shop];
      const token = global.shopTokens?.[shop];

      if (!settings?.autoUpdate || !token) continue;

      try {
        const rate = await getExchangeRate(
          settings.baseCurrency,
          settings.targetCurrency
        );

        // Only update if rate changed more than 0.5%
        const prevRate = settings.lastRate || 0;
        const changePct = Math.abs((rate - prevRate) / prevRate) * 100;

        if (prevRate > 0 && changePct < 0.5) {
          console.log(
            `⏩ ${shop}: Rate change ${changePct.toFixed(2)}% < 0.5%, skipping.`
          );
          continue;
        }

        const effectiveRate = rate * (1 + settings.margin / 100);
        const result = await updateAllProductPrices(shop, token, effectiveRate);

        global.shopSettings[shop].lastRate = rate;
        global.shopSettings[shop].lastUpdated = new Date().toISOString();

        console.log(
          `✅ ${shop}: Synced ${result.updatedCount} variants at rate ${effectiveRate.toFixed(4)}`
        );
      } catch (err) {
        console.error(`❌ Cron error for ${shop}:`, err.message);
      }
    }
  });

  console.log("⏰ Cron job scheduled: hourly rate sync active");
}
