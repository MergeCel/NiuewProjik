import { supabase } from "./supabase.js";

const DUP_HOURS = 6;
const DUP_ATR_MULT = 0.5;

// Return true if there is a recent signal (same pair, same direction) whose entry
// is within DUP_ATR_MULT x ATR of the new entry within the last DUP_HOURS.
export async function checkDuplicate(
  symbol: string,
  direction: string,
  entry: number | null,
  atr: number | null
): Promise<{ duplicate: boolean; existing: any | null }> {
  if (direction === "NO_TRADE" || entry == null || atr == null) {
    return { duplicate: false, existing: null };
  }
  const since = new Date(Date.now() - DUP_HOURS * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from("signals")
    .select("id, pair, direction, entry, created_at, status")
    .eq("pair", symbol)
    .eq("direction", direction)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) return { duplicate: false, existing: null };
  const existing = (data || []).find(
    (s: any) => s.entry != null && Math.abs(s.entry - entry) <= DUP_ATR_MULT * atr
  );
  return { duplicate: !!existing, existing: existing || null };
}

// Active (open) positions for a pair, used to inform Gemini about ongoing trades.
export async function getActivePositions(symbol: string): Promise<any[]> {
  const { data } = await supabase
    .from("signals")
    .select("direction, entry, sl, tp, confidence, created_at")
    .eq("pair", symbol)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(5);
  return data || [];
}