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

export interface StructureFilterResult {
  call: boolean;
  reason: string;
  structuralEvent: "SWEEP_BELOW" | "SWEEP_ABOVE" | null;
}

// Local Market Structure Filter (PRD Module A): menggantikan pre-filter RSI kaku.
// Hanya lanjut jika (1) volatilitas cukup (range candle terakhir >= 0.5×ATR) dan
// (2) ada structural event (sweep/break level kunci) dalam beberapa candle terakhir.
export function localStructureFilter(
  ind: IndicatorResult,
  highs: number[],
  lows: number[],
  sr15: SRResult
): StructureFilterResult {
  if (ind.rsi === null || ind.ema50 === null || ind.ema200 === null) {
    return { call: false, reason: "Not enough data for indicators", structuralEvent: null };
  }
  if (ind.atr === null || ind.atr <= 0) {
    return { call: false, reason: "ATR not available", structuralEvent: null };
  }

  // 1) Volatilitas minimal: range candle 15m terakhir >= 0.5×ATR
  const lastRange = highs[highs.length - 1] - lows[lows.length - 1];
  if (lastRange < 0.5 * ind.atr) {
    return {
      call: false,
      reason: `Volatilitas rendah (range ${lastRange.toFixed(4)} < 0.5×ATR ${(0.5 * ind.atr).toFixed(4)})`,
      structuralEvent: null,
    };
  }

  // 2) Structural event (HARD GATE): dalam 5 candle terakhir, harga sweep/break
  //    swing (jendela 20 candle sebelumnya) atau tembus zona S/R terdekat.
  const lookback = 5;
  const swingWindow = 20;
  const start = Math.max(0, lows.length - lookback);
  const swingStart = Math.max(0, start - swingWindow);
  const priorLows = lows.slice(swingStart, start);
  const priorHighs = highs.slice(swingStart, start);
  const swingLow = priorLows.length ? Math.min(...priorLows) : null;
  const swingHigh = priorHighs.length ? Math.max(...priorHighs) : null;

  for (let i = start; i < lows.length; i++) {
    if (swingLow !== null && lows[i] < swingLow) {
      return { call: true, reason: "Setup valid (sweep likuiditas di bawah struktur)", structuralEvent: "SWEEP_BELOW" };
    }
    if (swingHigh !== null && highs[i] > swingHigh) {
      return { call: true, reason: "Setup valid (sweep/break di atas struktur)", structuralEvent: "SWEEP_ABOVE" };
    }
  }
  const price = ind.price;
  if (sr15.nearestResistance && price > sr15.nearestResistance.maxPrice) {
    return { call: true, reason: "Setup valid (break resistance M15)", structuralEvent: "SWEEP_ABOVE" };
  }
  if (sr15.nearestSupport && price < sr15.nearestSupport.minPrice) {
    return { call: true, reason: "Setup valid (break support M15)", structuralEvent: "SWEEP_BELOW" };
  }
  return {
    call: false,
    reason: "Tidak ada structural event (sweep/break level kunci) dalam 5 candle terakhir",
    structuralEvent: null,
  };
}
