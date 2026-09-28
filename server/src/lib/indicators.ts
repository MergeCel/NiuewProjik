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

export interface SRZone {
  price: number;        // Nilai rata-rata/bobot harga zona
  minPrice: number;     // Batas bawah zona
  maxPrice: number;     // Batas atas zona
  strength: number;     // Jumlah titik swing dalam klaster (relevansi)
  type: 'SUPPORT' | 'RESISTANCE';
}

export interface SRResult {
  nearestSupport: SRZone | null;
  nearestResistance: SRZone | null;
  allZones: SRZone[];
}

/**
 * Menghitung zona Support & Resistance menggunakan klastering Swing Point berbasis ±0.6 x ATR
 */
export function computeSupportResistance(
  closes: number[],
  highs: number[],
  lows: number[],
  atr: number,
  pivotWindow: number = 3
): SRResult {
  if (closes.length < pivotWindow * 2 + 1 || atr <= 0) {
    return { nearestSupport: null, nearestResistance: null, allZones: [] };
  }

  const currentPrice = closes[closes.length - 1];
  const swingPoints: { price: number; type: 'HIGH' | 'LOW'; index: number }[] = [];

  // 1. Ekstraksi Swing High & Swing Low (Pivot Points)
  for (let i = pivotWindow; i < highs.length - pivotWindow; i++) {
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= pivotWindow; j++) {
      if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) isHigh = false;
      if (lows[i] >= lows[i - j] || lows[i] >= lows[i + j]) isLow = false;
    }

    if (isHigh) swingPoints.push({ price: highs[i], type: 'HIGH', index: i });
    if (isLow) swingPoints.push({ price: lows[i], type: 'LOW', index: i });
  }

  if (swingPoints.length === 0) {
    return { nearestSupport: null, nearestResistance: null, allZones: [] };
  }

  // 2. Klastering 1D Berdasarkan Jarak ±0.6 x ATR
  const threshold = 0.6 * atr;
  const sortedPoints = [...swingPoints].sort((a, b) => a.price - b.price);

  const clusters: { prices: number[]; indices: number[] }[] = [];
  let currentCluster: { prices: number[]; indices: number[] } = {
    prices: [sortedPoints[0].price],
    indices: [sortedPoints[0].index],
  };

  for (let i = 1; i < sortedPoints.length; i++) {
    const point = sortedPoints[i];
    const clusterMean =
      currentCluster.prices.reduce((a, b) => a + b, 0) / currentCluster.prices.length;

    // Jika jarak titik ke rerata klaster saat ini <= 0.6 x ATR, gabungkan
    if (Math.abs(point.price - clusterMean) <= threshold) {
      currentCluster.prices.push(point.price);
      currentCluster.indices.push(point.index);
    } else {
      clusters.push(currentCluster);
      currentCluster = { prices: [point.price], indices: [point.index] };
    }
  }
  clusters.push(currentCluster);

  // 3. Konversi Klaster ke SRZone dengan Pembobotan Recency
  const totalCandles = closes.length;
  const zones: SRZone[] = clusters.map((c) => {
    // Bobot recency: titik yang lebih baru memberikan bobot lebih tinggi
    let weightedSum = 0;
    let weightTotal = 0;

    for (let k = 0; k < c.prices.length; k++) {
      const recencyWeight = 1 + c.indices[k] / totalCandles; // Bobot 1.0 - 2.0
      weightedSum += c.prices[k] * recencyWeight;
      weightTotal += recencyWeight;
    }

    const avgPrice = weightedSum / weightTotal;
    const minP = Math.min(...c.prices);
    const maxP = Math.max(...c.prices);

    return {
      price: avgPrice,
      minPrice: Math.min(minP, avgPrice - threshold / 2),
      maxPrice: Math.max(maxP, avgPrice + threshold / 2),
      strength: c.prices.length,
      type: avgPrice < currentPrice ? 'SUPPORT' : 'RESISTANCE',
    };
  });

  // 4. Filter Zona Support Terdekat & Resistance Terdekat
  const supports = zones
    .filter((z) => z.price < currentPrice)
    .sort((a, b) => b.price - a.price); // Cari yang paling dekat di bawah harga saat ini

  const resistances = zones
    .filter((z) => z.price > currentPrice)
    .sort((a, b) => a.price - b.price); // Cari yang paling dekat di atas harga saat ini

  return {
    nearestSupport: supports.length > 0 ? supports[0] : null,
    nearestResistance: resistances.length > 0 ? resistances[0] : null,
    allZones: zones,
  };
}

export interface FibExtensions {
  up: { tp1272: number; tp1414: number; tp1618: number; tp200: number };
  down: { tp1272: number; tp1414: number; tp1618: number; tp200: number };
}

// Target Fibonacci extension di atas (up) dan bawah (down) rentang swing.
export function computeFibExtensions(swingHigh: number, swingLow: number): FibExtensions {
  const range = swingHigh - swingLow;
  return {
    up: {
      tp1272: swingHigh + range * 0.272,
      tp1414: swingHigh + range * 0.414,
      tp1618: swingHigh + range * 0.618,
      tp200: swingHigh + range,
    },
    down: {
      tp1272: swingLow - range * 0.272,
      tp1414: swingLow - range * 0.414,
      tp1618: swingLow - range * 0.618,
      tp200: swingLow - range,
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
