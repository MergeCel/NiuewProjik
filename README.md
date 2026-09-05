# Trading Bot - BTC 1H (Vite + Express + Gemini + Supabase) — Private

POC 1 bulan: hanya provide Entry / SL / TP, learning dari 10 loss terakhir + weekly lesson, tanpa broker.

## Stack
- **Client:** Vite React TS + Recharts, `robots.txt Disallow + noindex`
- **Server:** Express TS, Binance API, technicalindicators, Gemini 2.0-flash (fallback 1.5), Supabase
- **Cron:** GitHub Actions 1H (gratis, bypass Vercel Hobby 1/day limit)
- **Hosting:** Vercel (single deploy), Supabase Free
- **Auth:** Basic Auth + CRON_SECRET + X-Robots-Tag noindex

## Quick Start Lokal
```bash
# 1. Env
cp .env.example .env
cp .env server/.env  # isi GEMINI_API_KEY, SUPABASE_URL, SERVICE_ROLE, CRON_SECRET, ADMIN_USER/PASS

# 2. DB
# Copy supabase/schema.sql -> Supabase SQL Editor -> Run

# 3. Install & Dev
npm install --prefix server
npm install --prefix client
npm run dev:server  # http://localhost:3001
npm run dev:client  # http://localhost:5173 (proxy /api -> 3001)
```

## Env Wajib
`GEMINI_API_KEY` dari aistudio.google.com (Free 1500 req/hari), `GEMINI_MODEL=gemini-2.0-flash`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` (random 32 char), `ADMIN_USER`, `ADMIN_PASS`

## Env Opsional Mitigasi >1 Bulan
`BINANCE_API_KEY` + `BINANCE_API_SECRET` — **tidak wajib** untuk POC (public klines di `server/src/lib/binance.ts:1` tanpa key). Isi hanya jika setelah 1 bulan kena rate limit IP share Vercel atau mau upgrade ke private endpoints (balance/order). Server sudah handle header `X-MBX-APIKEY` otomatis jika env ada.

## Deploy Vercel (Gratis)
1. Push ke GitHub, import ke Vercel, set Env vars yang sama + `VERCEL=1`
2. `vercel.json` sudah set `X-Robots-Tag: noindex` global
3. Test: `curl -u admin:pass https://your-app.vercel.app/api/signals/stats`

## GitHub Actions Secrets (Repo Settings -> Secrets)
`APP_URL` = https://your-app.vercel.app
`CRON_SECRET` = sama dengan Vercel env

File workflow: `.github/workflows/cron-analyze.yml` (0 * * * *), `cron-evaluate.yml` (5 * * * *), `cron-reflect.yml` (weekly).

## API
- `POST /api/cron/analyze?symbol=BTCUSDT&interval=1h` header `x-cron-secret`
- `POST /api/cron/evaluate?symbol=BTCUSDT` header `x-cron-secret`
- `POST /api/cron/reflect` header `x-cron-secret`
- `GET /api/signals/stats` Basic Auth
- `GET /api/signals?limit=50` Basic Auth

## Ganti ke 15M
Ubah cron di workflow jadi `*/15 * * * *` tanpa ubah kode.

## NoIndex Verification
`curl -i https://your-app.vercel.app/` harus ada `X-Robots-Tag: noindex`, dan `https://your-app.vercel.app/robots.txt` = `Disallow: /`.
