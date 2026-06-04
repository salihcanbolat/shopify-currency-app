import dotenv from "dotenv";
dotenv.config();

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { shopifyAuth, loadTokens } from "./auth.js";
import { apiRouter } from "./api.js";
import { gdprRouter } from "./gdpr.js";
import { billingRouter } from "./billingRoutes.js";
import { productWebhookRouter } from "./productWebhooks.js";
import { scheduleCronJob } from "./cron.js";
import { initDb, loadAllSettings } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// index.html'i API key enjekte ederek serve et (statik servisten ÖNCE)
const INDEX_PATH = path.join(__dirname, "../public/index.html");
function serveIndex(req, res) {
  try {
    let html = fs.readFileSync(INDEX_PATH, "utf8");
    html = html.replace(/__SHOPIFY_API_KEY__/g, process.env.SHOPIFY_API_KEY || "");
    res.set("Content-Type", "text/html");
    res.send(html);
  } catch (e) {
    res.status(500).send("Index yüklenemedi");
  }
}
app.get("/", serveIndex);
app.get("/index.html", serveIndex);

// Diğer statik dosyalar (varsa)
app.use(express.static(path.join(__dirname, "../public")));

// Routes
app.use("/auth", shopifyAuth);
app.use("/api", apiRouter);
app.use("/webhooks", gdprRouter);
app.use("/billing", billingRouter);
app.use("/webhooks", productWebhookRouter);

// DB başlat ve uygulamayı başlat
async function startServer() {
  try {
    await initDb();
    await loadTokens();
    await loadAllSettings();
    console.log("✅ Veritabanı bağlantısı kuruldu");
  } catch(e) {
    console.error("⚠️ DB bağlantısı kurulamadı, dosya tabanlı çalışılıyor:", e.message);
  }

  scheduleCronJob();

  app.listen(PORT, () => {
    console.log(`✅ Currency App running on http://localhost:${PORT}`);
  });
}

startServer();