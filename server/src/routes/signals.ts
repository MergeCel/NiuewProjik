import { Router, type Request, type Response } from "express";
import { supabase } from "../lib/supabase.js";
import { SUPPORTED_PAIRS } from "../lib/pairs.js";

const router = Router();

// GET /api/signals - list recent
// Filters: ?pair=, ?status=, ?direction=, ?trade_only=1 (exclude NO_TRADE), ?result=WIN|LOSS|BE
// NOTE: NO_TRADE rows flood the DB (1 per pair per 15min), so result/status filters must scan
// full history server-side instead of the latest N rows.
router.get("/", async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const pair = (req.query.pair as string) || "";
  const status = (req.query.status as string) || "";
  const direction = (req.query.direction as string) || "";
  const result = (req.query.result as string) || "";
  const tradeOnly = (req.query.trade_only as string) === "1";

  let query = supabase
    .from("signals")
    .select("*, outcomes(*)")
    .order("created_at", { ascending: false });
  if (pair && pair !== "ALL") query = query.eq("pair", pair.toUpperCase());
  if (status && status !== "ALL") query = query.eq("status", status.toLowerCase());
  if (direction && direction !== "ALL") query = query.eq("direction", direction.toUpperCase());
  if (tradeOnly) query = query.neq("direction", "NO_TRADE");

  // result filter cannot be expressed as a simple column eq -> fetch wide, filter in memory
  const fetchLimit = result && result !== "ALL" ? 5000 : limit;
  const { data, error } = await query.limit(fetchLimit);
  if (error) return res.status(500).json({ error: error.message });

  let out = data || [];
  if (result && result !== "ALL") {
    out = out.filter((s: any) => s.outcomes?.[0]?.result === result.toUpperCase());
  }
  res.json(out.slice(0, limit));
});

// GET /api/signals/stats (optional ?pair= filter)
router.get("/stats", async (req: Request, res: Response) => {
  const pair = (req.query.pair as string) || "";
  let query = supabase.from("signals").select("*, outcomes(result, pnl_pips)");
  if (pair && pair !== "ALL") query = query.eq("pair", pair.toUpperCase());
  const { data: signals, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const total = signals.length;
  const wins = signals.filter((s: any) => s.outcomes?.[0]?.result === "WIN").length;
  const losses = signals.filter((s: any) => s.outcomes?.[0]?.result === "LOSS").length;
  const be = signals.filter((s: any) => s.outcomes?.[0]?.result === "BE").length;
  const active = signals.filter((s: any) => s.status === "active").length;
  const suppressed = signals.filter((s: any) => s.status === "suppressed").length;
  const winrate = total ? (wins / (wins + losses || 1)) * 100 : 0;

  const pnl = signals.reduce((sum: number, s: any) => sum + (s.outcomes?.[0]?.pnl_pips || 0), 0);

  const { data: reflection } = await supabase
    .from("ai_reflections")
    .select("*")
    .order("week_start", { ascending: false })
    .limit(1)
    .maybeSingle();

  res.json({
    total,
    wins,
    losses,
    be,
    active,
    suppressed,
    winrate: Number(winrate.toFixed(2)),
    pnl: Number(pnl.toFixed(2)),
    reflection,
    pairs: SUPPORTED_PAIRS,
    selectedPair: pair || "ALL",
  });
});

// GET /api/signals/:id
router.get("/:id", async (req: Request, res: Response) => {
  const { data, error } = await supabase.from("signals").select("*, outcomes(*)").eq("id", req.params.id).single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

export default router;
