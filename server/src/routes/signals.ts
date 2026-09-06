import { Router, type Request, type Response } from "express";
import { supabase } from "../lib/supabase.js";
import { SUPPORTED_PAIRS } from "../lib/pairs.js";

const router = Router();

// GET /api/signals - list recent (optional ?pair= filter)
router.get("/", async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const pair = (req.query.pair as string) || "";
  let query = supabase
    .from("signals")
    .select("*, outcomes(*)")
    .order("created_at", { ascending: false });
  if (pair && pair !== "ALL") query = query.eq("pair", pair.toUpperCase());
  const { data, error } = await query.limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
