import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cronRouter from "./routes/cron.js";
import signalsRouter from "./routes/signals.js";
import { basicAuth } from "./middleware/auth.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Health check - no auth
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
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
