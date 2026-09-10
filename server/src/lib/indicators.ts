import { RSI, EMA, ATR } from "technicalindicators";

export interface IndicatorResult {
  rsi: number | null;
  ema50: number | null;
  ema200: number | null;
  atr: number | null;
  price: number;
  trend: "UP" | "DOWN" | "SIDEWAYS";
}

export function computeAtr(highs: number[], lows: number[], closes: number[], period = 14): number | null {
  const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period });
  return atrArr.length ? atrArr[atrArr.length - 1] : null;
}

export function computeIndicators(closes: number[], highs: number[], lows: number[]): IndicatorResult {
  const price = closes[closes.length - 1];

  const rsiArr = RSI.calculate({ values: closes, period: 14 });
  const rsi = rsiArr.length ? rsiArr[rsiArr.length - 1] : null;

  const ema50Arr = EMA.calculate({ values: closes, period: 50 });
  const ema200Arr = EMA.calculate({ values: closes, period: 200 });
  const ema50 = ema50Arr.length ? ema50Arr[ema50Arr.length - 1] : null;
  const ema200 = ema200Arr.length ? ema200Arr[ema200Arr.length - 1] : null;

  const atr = computeAtr(highs, lows, closes, 14);

  let trend: IndicatorResult["trend"] = "SIDEWAYS";
  if (ema50 !== null && ema200 !== null) {
    if (ema50 > ema200) trend = "UP";
    else if (ema50 < ema200) trend = "DOWN";
  }

  return { rsi, ema50, ema200, atr, price, trend };
}

export interface SwingLevels {
  swingHigh: number;
  swingLow: number;
  fib: { lvl382: number; lvl50: number; lvl618: number };
}

// Swing high/low over last 96 candles + Fibonacci retracement levels (0.382/0.5/0.618)
export function computeSwingLevels(closes: number[]): SwingLevels {
  const window = closes.slice(-96);
  const swingHigh = Math.max(...window);
  const swingLow = Math.min(...window);
  const diff = swingHigh - swingLow;
  return {
    swingHigh,
    swingLow,
    fib: {
      lvl382: swingHigh - diff * 0.382,
      lvl50: swingHigh - diff * 0.5,
      lvl618: swingHigh - diff * 0.618,
    },
  };
}

export function shouldCallLLM(ind: IndicatorResult): { call: boolean; reason: string } {
  // Pre-filter tuned for 15m sniping
  if (ind.rsi === null || ind.ema50 === null || ind.ema200 === null) {
    return { call: false, reason: "Not enough data for indicators" };
  }
  // If RSI in neutral and price far from EMAs -> no setup
  const distFromEma = Math.abs(ind.price - ind.ema50) / ind.price;
  if (ind.rsi > 45 && ind.rsi < 55 && distFromEma > 0.008) {
    return { call: false, reason: `RSI neutral ${ind.rsi.toFixed(1)} and price far from EMA50` };
  }
  // Avoid calling on extreme sideways with low ATR (15m ATR ~0.05-0.1%)
  if (ind.atr !== null && ind.atr / ind.price < 0.0006) {
    return { call: false, reason: "ATR too low, no volatility" };
  }
  return { call: true, reason: "Setup valid" };
}
