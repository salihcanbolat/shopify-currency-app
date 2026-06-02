import dotenv from "dotenv";
dotenv.config();

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { shopifyAuth, loadTokens } from "./auth.js";
import { apiRouter } from "./api.js";
import { gdprRouter } from "./gdpr.js";
import { billingRouter } from "./billingRoutes.js";
import { scheduleCronJob } from "./cron.js";
import { initDb, loadAllSettings } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "../public")));

// DB başlat ve verileri yükle
await initDb();
await loadTokens();
await loadAllSettings();

// Routes
app.use("/auth", shopifyAuth);
app.use("/api", apiRouter);
app.use("/webhooks", gdprRouter);
app.use("/billing", billingRouter);

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

scheduleCronJob();

app.listen(PORT, () => {
  console.log(`✅ Currency App running on http://localhost:${PORT}`);
});