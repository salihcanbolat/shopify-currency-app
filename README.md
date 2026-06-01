# KurSync — Shopify Kur Dönüşüm Uygulaması

Shopify mağazanızdaki ürün fiyatlarını, kaynak para biriminden hedef para birimine **otomatik olarak** güncelleyen embedded app.

---

## Nasıl Çalışır?

1. Mağaza sahibi **kaynak para birimi** seçer (örn. USD)
2. **Hedef para birimi** seçer (örn. TRY)
3. İsteğe bağlı **marj yüzdesi** ekler (buffer için)
4. Güncel kur anlık olarak gösterilir
5. "Şimdi Senkronize Et" ile tüm ürün fiyatları TRY olarak güncellenir
6. Saatlik cron job kur değişimlerini takip eder

---

## Kurulum

### 1. Gereksinimler
- Node.js 18+
- Shopify Partners hesabı: https://partners.shopify.com
- ngrok (geliştirme için): https://ngrok.com

### 2. Shopify App Oluşturma
1. [Partners Dashboard](https://partners.shopify.com) → Apps → Create app
2. App URL: `https://your-ngrok.ngrok.io`
3. Allowed redirect URL: `https://your-ngrok.ngrok.io/auth/callback`
4. API Key ve Secret'ı kopyalayın

### 3. Projeyi Kurma
```bash
git clone <repo>
cd shopify-currency-app
npm install

# .env dosyası oluştur
cp .env.example .env
# .env içine API Key ve Secret gir
```

### 4. ngrok ile Çalıştırma
```bash
# Terminal 1: ngrok
ngrok http 3000

# Terminal 2: App
npm run dev
```

### 5. App'i Mağazaya Kurma
```
https://your-shop.myshopify.com/admin/oauth/authorize?
  client_id=YOUR_API_KEY&
  scope=write_products,read_products&
  redirect_uri=https://your-ngrok.ngrok.io/auth/callback
```

---

## Proje Yapısı

```
shopify-currency-app/
├── src/
│   ├── server.js        # Express server, routing
│   ├── auth.js          # Shopify OAuth flow
│   ├── api.js           # REST API endpoints
│   ├── rateService.js   # Kur çekme + cache
│   ├── priceUpdater.js  # Shopify GraphQL bulk update
│   └── cron.js          # Saatlik otomatik güncelleme
├── public/
│   └── index.html       # Embedded app UI
├── .env.example
├── shopify.app.toml
└── package.json
```

---

## API Endpointleri

| Method | Endpoint | Açıklama |
|--------|----------|----------|
| GET | `/api/currencies` | Desteklenen para birimleri |
| GET | `/api/rate?base=USD&target=TRY` | Anlık kur |
| GET | `/api/settings?shop=xxx` | Mağaza ayarları |
| POST | `/api/settings` | Ayarları kaydet |
| POST | `/api/sync` | Manuel senkronizasyon |

---

## Üretim Ortamı (Production)

1. **Hosting:** Railway, Render, Fly.io veya Heroku
2. **Veritabanı:** `global.shopTokens/Settings` yerine PostgreSQL + Prisma kullanın
3. **Kur API:** `open.er-api.com` (ücretsiz, saatlik limit var)
   - Daha güvenilir için: `fixer.io` veya `exchangerate-api.com` ücretli plan
4. **Shopify App Review:** Yayınlanmadan önce GDPR webhook'larını aktif edin

---

## Geliştirme Notları

### Fiyat Güncelleme Mantığı
Ürünlerin USD bazındaki orijinal fiyatı `compareAtPrice` alanında saklanır.
Dönüşüm: `price = compareAtPrice × kur × (1 + marj/100)`

### Rate Limit Yönetimi
Shopify GraphQL API'nin maliyet bütçesi vardır. 1000+ ürün için batch işlem
ve `DELAY_MS` ayarlarını `priceUpdater.js` içinden düzenleyin.
