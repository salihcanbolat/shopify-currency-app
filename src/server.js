import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { shopifyAuth, loadTokens } from "./auth.js";
import { apiRouter } from "./api.js";
import { scheduleCronJob } from "./cron.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "../public")));

// Tokenları dosyadan yükle (uygulama başlarken)
loadTokens();

// Shopify OAuth routes
app.use("/auth", shopifyAuth);

// API routes
app.use("/api", apiRouter);

// Embedded app entry
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// Start cron job
scheduleCronJob();

app.listen(PORT, () => {
  console.log(`✅ Currency App running on http://localhost:${PORT}`);
});