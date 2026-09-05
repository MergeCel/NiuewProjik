import { RSI, EMA, ATR } from "technicalindicators";

export interface IndicatorResult {
  rsi: number | null;
  ema50: number | null;
  ema200: number | null;
  atr: number | null;
  price: number;
  trend: "UP" | "DOWN" | "SIDEWAYS";
}

export function computeIndicators(closes: number[], highs: number[], lows: number[]): IndicatorResult {
  const price = closes[closes.length - 1];

  const rsiArr = RSI.calculate({ values: closes, period: 14 });
  const rsi = rsiArr.length ? rsiArr[rsiArr.length - 1] : null;

  const ema50Arr = EMA.calculate({ values: closes, period: 50 });
  const ema200Arr = EMA.calculate({ values: closes, period: 200 });
  const ema50 = ema50Arr.length ? ema50Arr[ema50Arr.length - 1] : null;
  const ema200 = ema200Arr.length ? ema200Arr[ema200Arr.length - 1] : null;

  const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atr = atrArr.length ? atrArr[atrArr.length - 1] : null;

  let trend: IndicatorResult["trend"] = "SIDEWAYS";
  if (ema50 !== null && ema200 !== null) {
    if (ema50 > ema200) trend = "UP";
    else if (ema50 < ema200) trend = "DOWN";
  }

  return { rsi, ema50, ema200, atr, price, trend };
}

export function shouldCallLLM(ind: IndicatorResult): { call: boolean; reason: string } {
  // Pre-filter to save Gemini calls
  if (ind.rsi === null || ind.ema50 === null || ind.ema200 === null) {
    return { call: false, reason: "Not enough data for indicators" };
  }
  // If RSI in neutral and price far from EMAs -> no setup
  const distFromEma = Math.abs(ind.price - ind.ema50) / ind.price;
  if (ind.rsi > 45 && ind.rsi < 55 && distFromEma > 0.015) {
    return { call: false, reason: `RSI neutral ${ind.rsi.toFixed(1)} and price far from EMA50` };
  }
  // Avoid calling on extreme sideways with low ATR
  if (ind.atr !== null && ind.atr / ind.price < 0.002) {
    return { call: false, reason: "ATR too low, no volatility" };
  }
  return { call: true, reason: "Setup valid" };
}
