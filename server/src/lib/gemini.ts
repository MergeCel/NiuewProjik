import { GoogleGenerativeAI } from "@google/generative-ai";

// Gemini = QUALITATIVE CONTEXT CLASSIFIER (PRD Module B).
// TIDAK menghitung Entry/SL/TP (itu tugas engine deterministik di cron.ts).
export interface GeminiBias {
  bias: "LONG" | "SHORT" | "NO_TRADE";
  confidence: number;
  invalidation_condition: string;
  reasoning: string;
}

// Urutan prioritas: model yang SAAT INI tersedia lebih dulu.
// gemini-3.5-flash-lite & gemini-3.5-flash sedang 503 "high demand" (overload Google);
// gemini-3-flash-preview adalah satu-satunya yang berjalan (kuota free-tier kecil ~20/hari).
const MODEL_FALLBACKS = ["gemini-3-flash-preview", "gemini-3.5-flash-lite", "gemini-3.5-flash"];

export function extractJson(text: string): string {
  const t = text.trim();
  // Direct JSON
  if (t.startsWith("{") && t.endsWith("}")) return t;
  if (t.startsWith("[") && t.endsWith("]")) return t;
  // JSON object - greedy match to LAST brace (handles braces inside strings)
  const objMatch = t.match(/\{[\s\S]*\}/);
  if (objMatch) return objMatch[0];
  // JSON array
  const arrMatch = t.match(/\[[\s\S]*\]/);
  if (arrMatch) return arrMatch[0];
  return t;
}

export async function callGemini(prompt: string, modelOverride?: string): Promise<{ signal: GeminiBias; model: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY missing");

  const preferred = modelOverride || process.env.GEMINI_MODEL || "gemini-3-flash-preview";
  const modelsToTry = [preferred, ...MODEL_FALLBACKS.filter((m) => m !== preferred)];

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const noTrade = (reasoning: string): GeminiBias => ({
    bias: "NO_TRADE",
    confidence: 0,
    invalidation_condition: "Panggilan model gagal/kuota; tidak ada bias.",
    reasoning,
  });

  let lastError: any;
  const MAX_ATTEMPTS = 2; // initial + 1 retry on rate limit

  for (const modelName of modelsToTry) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.3,
            maxOutputTokens: 2048,
          },
        });

        const result = await model.generateContent(prompt);
        const text = result.response.text();
        // Clean possible markdown fences and extract JSON robustly
        const cleaned = extractJson(text);
        const parsed = JSON.parse(cleaned) as GeminiBias;

        // Validate
        if (!["LONG", "SHORT", "NO_TRADE"].includes(parsed.bias)) {
          throw new Error(`Invalid bias ${parsed.bias}`);
        }
        if (typeof parsed.confidence !== "number" || parsed.confidence < 0 || parsed.confidence > 100) {
          throw new Error("Invalid confidence");
        }
        return { signal: parsed, model: modelName };
      } catch (e) {
        lastError = e;
        const msg = String((e as Error).message);
        console.warn(`Gemini model ${modelName} attempt ${attempt} failed:`, msg);
        // Truncated/invalid JSON: treat as NO_TRADE so analyze still succeeds
        if (msg.includes("Unterminated string") || msg.includes("Expected")) {
          return { signal: noTrade(`Gemini ${modelName} returned invalid JSON; treated as no-trade`), model: modelName };
        }
        const isRateLimit = msg.includes("429") || msg.includes("RATE_LIMIT") || msg.includes("RESOURCE_EXHAUSTED");
        if (isRateLimit) {
          if (attempt < MAX_ATTEMPTS) {
            await sleep(8000); // backoff then retry same model
            continue;
          }
          // attempts exhausted -> try next model
        } else {
          break; // non-rate-limit error -> try next model
        }
      }
    }
  }
  // All models exhausted -> clean NO_TRADE instead of throwing (avoid 500 spam)
  return { signal: noTrade(`Gemini models unavailable: ${lastError?.message}`), model: modelsToTry[0] };
}

export async function callGroundedGemini(prompt: string): Promise<{ text: string; model: string; grounded: boolean }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY missing");

  const preferred = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const modelsToTry = [preferred, ...MODEL_FALLBACKS.filter((m) => m !== preferred)];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const genAI = new GoogleGenerativeAI(apiKey);
  const isQuota = (msg: string) =>
    msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota");

  // 1) Coba grounding googleSearch (kuota TERPISAH dari RPD biasa, sering habis
  //    di free tier). Satu percobaan per model, tanpa sleep lama (batas Vercel 60s).
  let lastError: any;
  for (const modelName of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        // googleSearch: grounding sederhana dari Gemini API (gratis).
        // Tipe SDK 0.21 belum memuatnya (hanya GoogleSearchRetrievalTool), cast saja.
        tools: [{ googleSearch: {} }] as any,
        generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
      });
      const result = await model.generateContent(prompt);
      return { text: result.response.text(), model: modelName, grounded: true };
    } catch (e) {
      lastError = e;
      console.warn(`grounded ${modelName} failed:`, (e as Error).message);
      if (isQuota(String((e as Error).message))) await sleep(2000);
    }
  }

  // 2) Fallback: panggilan PLAIN tanpa grounding agar strategy_notes tetap terisi
  //    (evaluasi strategi dari pengetahuan model) walau grounding tak tersedia.
  //    TANPA sleep lama — batas Vercel maxDuration 60s (reflect 504 bila melebihi).
  console.warn("grounding unavailable, falling back to plain call:", lastError?.message);
  for (const modelName of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
      });
      const result = await model.generateContent(prompt);
      return { text: result.response.text(), model: modelName, grounded: false };
    } catch (e) {
      lastError = e;
      console.warn(`plain ${modelName} failed:`, (e as Error).message);
      await sleep(2000);
    }
  }
  throw lastError;
}

export function buildPrompt(params: {
  pair: string;
  timeframe: string;
  price: number;
  rsi: number | null;
  ema50: number | null;
  ema200: number | null;
  atr: number | null;
  trend: string;
  htfBias: "UP" | "DOWN" | "SIDEWAYS";
  htfPrice: number | null;
  htfEma50: number | null;
  htfEma200: number | null;
  session: "HIGH" | "LOW";
  swingHigh: number;
  swingLow: number;
  fib: { lvl382: number; lvl50: number; lvl618: number };
  fibExt: { up: { tp1272: number; tp1414: number; tp1618: number; tp200: number }; down: { tp1272: number; tp1414: number; tp1618: number; tp200: number } };
  support15: number | null;
  resistance15: number | null;
  support15Strength: number | null;
  resistance15Strength: number | null;
  support4h: number | null;
  resistance4h: number | null;
  support4hStrength: number | null;
  resistance4hStrength: number | null;
  structuralEvent: "SWEEP_BELOW" | "SWEEP_ABOVE" | null;
  activePositions: any[];
  recentLosses: any[];
  weeklyLesson: string | null;
  strategyNotes: string | null;
  fearGreed: { value: number; classification: string } | null;
  news: { title: string; source: string }[];
  klinesSummary: string;
}): string {
  const lossesText =
    params.recentLosses.length === 0
      ? "Belum ada loss, ini awal."
      : params.recentLosses
          .map(
            (l, i) =>
              `${i + 1}. ${l.direction} entry ${l.entry} SL ${l.sl} TP ${l.tp} -> ${l.result} (${l.hit}) reasoning: ${l.reasoning?.slice(0, 120)}`
          )
          .join("\n");

  const lesson = params.weeklyLesson || "Belum ada lesson mingguan.";
  const strategyNotes = params.strategyNotes || "Belum ada strategy notes.";
  const sentiment =
    params.fearGreed === null
      ? "n/a"
      : `F&G ${params.fearGreed.value} (${params.fearGreed.classification})`;
  const newsText =
    params.news.length === 0
      ? "Tidak ada berita."
      : params.news.map((n) => `- [${n.source}] ${n.title}`).join("\n");

  const activeText =
    params.activePositions.length === 0
      ? "Tidak ada posisi aktif."
      : params.activePositions
          .map(
            (p) =>
              `- ${p.direction} entry ${p.entry} SL ${p.sl} TP ${p.tp} (conf ${p.confidence}, umur ${Math.round((Date.now() - new Date(p.created_at).getTime()) / 3600000)} jam)`
          )
          .join("\n");

  return `You are a ${params.pair} ${params.timeframe} SNIPER QUALITATIVE CONTEXT CLASSIFIER using Smart Money Concepts (SMC) + Fibonacci. You do NOT calculate numeric Entry/SL/TP — a deterministic engine computes them. Your ONLY job: decide directional BIAS, CONFIDENCE, and INVALIDATION condition from the technical/qualitative context.

MARKET DATA (Binance ${params.timeframe}, ${params.pair}):
Price: ${params.price}
RSI(14): ${params.rsi?.toFixed(2) ?? "n/a"}
EMA50: ${params.ema50?.toFixed(2) ?? "n/a"}
EMA200: ${params.ema200?.toFixed(2) ?? "n/a"}
ATR(14): ${params.atr?.toFixed(2) ?? "n/a"}
Trend (EMA50 vs EMA200): ${params.trend}
Swing High: ${params.swingHigh.toFixed(2)}
Swing Low: ${params.swingLow.toFixed(2)}
Fibonacci (retracement): 0.382: ${params.fib.lvl382.toFixed(2)} | 0.5: ${params.fib.lvl50.toFixed(2)} | 0.618: ${params.fib.lvl618.toFixed(2)}
Recent klines: ${params.klinesSummary}

HTF BIAS (4H — arah utama, wajib patuh):
Trend 4H: ${params.htfBias}
4H Price: ${params.htfPrice?.toFixed(2) ?? "n/a"}
4H EMA50: ${params.htfEma50?.toFixed(2) ?? "n/a"}
4H EMA200: ${params.htfEma200?.toFixed(2) ?? "n/a"}

SESSION:
Likuiditas: ${params.session === "HIGH" ? "Tinggi (London/NY)" : "RENDAH (Asia/off-hours)"}

SUPPORT/RESISTANCE ZONES (M15, dari klaster swing point OHLC):
Nearest Support: ${params.support15 ?? "n/a"} (strength ${params.support15Strength ?? 0})
Nearest Resistance: ${params.resistance15 ?? "n/a"} (strength ${params.resistance15Strength ?? 0})

H4 ZONES (area kunci jangka menengah):
H4 Support: ${params.support4h ?? "n/a"} (strength ${params.support4hStrength ?? 0})
H4 Resistance: ${params.resistance4h ?? "n/a"} (strength ${params.resistance4hStrength ?? 0})

FIB EXTENSION TARGETS (dari rentang swing):
Up: 1.272=${params.fibExt.up.tp1272.toFixed(2)} | 1.414=${params.fibExt.up.tp1414.toFixed(2)} | 1.618=${params.fibExt.up.tp1618.toFixed(2)} | 2.0=${params.fibExt.up.tp200.toFixed(2)}
Down: 1.272=${params.fibExt.down.tp1272.toFixed(2)} | 1.414=${params.fibExt.down.tp1414.toFixed(2)} | 1.618=${params.fibExt.down.tp1618.toFixed(2)} | 2.0=${params.fibExt.down.tp200.toFixed(2)}

STRUCTURAL EVENT (terdeteksi lokal, 5 candle terakhir):
${params.structuralEvent === "SWEEP_BELOW"
    ? "Likuiditas tersapu di bawah struktur / break support (potensi reversal-up ATAU kelanjutan turun — nilai dengan struktur/CHoCH)."
    : params.structuralEvent === "SWEEP_ABOVE"
    ? "Likuiditas tersapu di atas struktur / break resistance (potensi reversal-down ATAU kelanjutan naik — nilai dengan struktur/CHoCH)."
    : "Volatilitas cukup, tanpa sweep/break level kunci — trade hanya jika setup sangat jelas."}

POSISI AKTIF (pair ini):
${activeText}

LEARNING FROM MISTAKES - 5 LOSS TERAKHIR:
${lossesText}

WEEKLY LESSON:
${lesson}

STRATEGY NOTES (rekomendasi evaluasi mingguan — BANDINGKAN dengan 5 loss terakhir di LEARNING FROM MISTAKES: jika rekomendasi ini terbukti mengatasi pola kesalahan yang muncul di loss → TERAPKAN. Jika tidak relevan dengan loss pattern kita → abaikan):
${strategyNotes}

MARKET SENTIMENT (KONTEKS PENDUKUNG, bukan larangan):
Fear & Greed: ${sentiment}
Berita terkini: ${newsText}

KEPUTUSAN & RULES (ANDA HANYA KLASIFIKASI ARAH — JANGAN HITUNG ANGKA):
- Peran Anda = QUALITATIVE CONTEXT CLASSIFIER. Entry, SL, TP, RR dihitung oleh ENGINE deterministik. JANGAN mengeluarkan angka level — hanya bias + confidence + invalidation_condition + reasoning.
- DASAR UTAMA = setup TEKNIKAL (SMC + Fib + trend). F&G & berita adalah PENDUKUNG yang menambah/mengurangi CONFIDENCE — BUKAN filter yang melarang arah tertentu.
- LARANGAN ABSOLUT: JANGAN pernah memblokir SATU arah penuh (semua LONG ATAU semua SHORT) hanya karena F&G / berita / strategy_notes. F&G tinggi TIDAK melarang short; berita buruk utk satu koin TIDAK melarang semua trade pada koin itu. Guard ini MENGALAHKAN isi STRATEGY NOTES yang terkesan absolut — rekomendasi mingguan hanyalah saran, bukan hukum.
- HTF BIAS (4H): bias HARUS searah trend 4H. Jika 4H DOWN → bias LONG dilarang; jika 4H UP → bias SHORT dilarang; jika 4H SIDEWAYS → fleksibel.
- SESSION: jika sesi LOW-liquidity (Asia/off-hours) → HANYA bias LONG/SHORT jika confidence >=78 dan searah HTF bias; hindari bias marginal.
- GUNAKAN BERITA & F&G SECARA CERDAS: baca konteks berita terkini untuk pair ini (isu keamanan/keuangan exchange, kebijakan, berita makro). Nilai: apakah berita negatif/positif utk pair ini, apakah penanganannya baik & terkonfirmasi, bagaimana sentimen umum pengguna/forum. Ubah menjadi PENYESUAIAN CONFIDENCE:
  * sentimen/berita positif + setup teknikal LONG selaras → confidence NAIK;
  * berita/sentimen BURUK utk pair (walau teknikal LONG) → TURUNKAN confidence, pertimbangkan NO_TRADE atau SHORT;
  * jika berniat SHORT tapi teknikal BELUM mendukung → tunggu konfirmasi teknikal ATAU momen berita yang tepat; JANGAN paksa.
- KONFIRMASI MASUK: cukup 1 indikasi struktur yang jelas (retest order block / sweep likuiditas / ChoCH) yang selaras trend. JANGAN menuntut konfirmasi sempurna — hindari MISS sinyal yang valid.
- ANTI-OVER-TRADING: jika sudah ada posisi aktif SEARAH pada pair ini → bias NO_TRADE (jangan continuation/re-entry).
- FLIP POSISI (BERLAWANAN): jika sudah ada posisi aktif dan Anda ingin mengambil arah BERLAWANAN → BOLEH HANYA bila news/sentimen TERKONFIRMASI jelas menunjukkan peralihan arah utk pair ini (contoh: berita bearish terkonfirmasi saat posisi LONG aktif, PLUS breakdown struktur/CHoCH selaras arah baru). Tanpa peralihan yang terkonfirmasi → JANGAN flip; hormati posisi aktif. Ini bukan izin stacking/rata-rata turun — flip hanya untuk reversal nyata.
- COOLDOWN SELEKTIF (HANYA bila strategy_notes mendukung DAN data loss jelas menunjukkan over-trading pada pair itu): boleh mempertimbangkan mengurangi frekuensi entry berulang pada pair yang sama. Ini SUATU PERTIMBANGAN, bukan larangan global.
- Jika confidence <70, output bias NO_TRADE.
- Jangan ulangi pattern loss di atas (premature entry, SL terlalu ketat, blind entry di retracement).
- invalidation_condition: tulis kondisi STRUKTURAL yang membatalkan bias (mis. close di bawah/atas level X, loss of structure/CHoCH berlawanan). Beri yang konkret.
- Output JSON ONLY, no markdown.

Format JSON:
{
  "bias": "LONG" | "SHORT" | "NO_TRADE",
  "confidence": number (0-100),
  "invalidation_condition": "string, kondisi struktural yang membatalkan bias",
  "reasoning": "string max 300 chars, analisis kualitatif SMC/price action + pengaruh F&G/berita + lesson applied"
}
`;
}
