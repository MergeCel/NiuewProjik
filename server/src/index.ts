import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cronRouter from "./routes/cron.js";
import signalsRouter from "./routes/signals.js";
import { basicAuth } from "./middleware/auth.js";
import { fetchKlines } from "./lib/binance.js";
import { supabase } from "./lib/supabase.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Health check - no auth
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Diagnostic endpoint - behind basic auth, reveals which env/deps are OK
app.get("/api/diag", basicAuth, async (_req, res) => {
  const has = (k: string) => !!process.env[k];
  const out: any = {
    time: new Date().toISOString(),
    env: {
      GEMINI_API_KEY: has("GEMINI_API_KEY"),
      GEMINI_MODEL: process.env.GEMINI_MODEL || null,
      SUPABASE_URL: has("SUPABASE_URL"),
      SUPABASE_SERVICE_ROLE_KEY: has("SUPABASE_SERVICE_ROLE_KEY"),
      CRON_SECRET: has("CRON_SECRET"),
      ADMIN_USER: has("ADMIN_USER"),
      ADMIN_PASS: has("ADMIN_PASS"),
    },
  };
  try {
    const k = await fetchKlines("BTCUSDT", "1h", 2);
    out.binance = { ok: true, closes: k.map((x) => x.close) };
  } catch (e: any) {
    out.binance = { ok: false, error: e.message };
  }
  try {
    const { data, error } = await supabase.from("signals").select("id").limit(1);
    out.supabase = { ok: !error, error: error?.message || null, rowCount: data?.length ?? 0 };
  } catch (e: any) {
    out.supabase = { ok: false, error: e.message };
  }
  res.json(out);
});

// Cron routes - protected by x-cron-secret (not basic auth)
app.use("/api/cron", cronRouter);

// Protected routes - basic auth
app.use("/api/signals", basicAuth, signalsRouter);

// Dashboard stats protected
app.get("/api/stats", basicAuth, async (req, res) => {
  // re-export logic from signals router
  res.redirect("/api/signals/stats");
});

// For local dev
const PORT = process.env.PORT || 3001;
if (process.env.VERCEL !== "1") {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

export default app;
