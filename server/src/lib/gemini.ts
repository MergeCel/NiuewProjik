import { GoogleGenerativeAI } from "@google/generative-ai";

export interface GeminiSignal {
  direction: "LONG" | "SHORT" | "NO_TRADE";
  entry: number | null;
  sl: number | null;
  tp: number | null;
  confidence: number;
  reasoning: string;
  rr: number | null;
}

const MODEL_FALLBACKS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];

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

export async function callGemini(prompt: string, modelOverride?: string): Promise<{ signal: GeminiSignal; model: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY missing");

  const preferred = modelOverride || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const modelsToTry = [preferred, ...MODEL_FALLBACKS.filter((m) => m !== preferred)];

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const noTrade = (reasoning: string): GeminiSignal => ({
    direction: "NO_TRADE",
    entry: null,
    sl: null,
    tp: null,
    confidence: 0,
    reasoning,
    rr: null,
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
        const parsed = JSON.parse(cleaned) as GeminiSignal;

        // Validate
        if (!["LONG", "SHORT", "NO_TRADE"].includes(parsed.direction)) {
          throw new Error(`Invalid direction ${parsed.direction}`);
        }
        if (parsed.direction !== "NO_TRADE") {
          if (parsed.entry == null || parsed.sl == null || parsed.tp == null) {
            throw new Error("Missing entry/sl/tp for trade");
          }
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

export function buildPrompt(params: {
  pair: string;
  timeframe: string;
  price: number;
  rsi: number | null;
  ema50: number | null;
  ema200: number | null;
  atr: number | null;
  trend: string;
  swingHigh: number;
  swingLow: number;
  fib: { lvl382: number; lvl50: number; lvl618: number };
  activePositions: any[];
  recentLosses: any[];
  weeklyLesson: string | null;
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

  const activeText =
    params.activePositions.length === 0
      ? "Tidak ada posisi aktif."
      : params.activePositions
          .map(
            (p) =>
              `- ${p.direction} entry ${p.entry} SL ${p.sl} TP ${p.tp} (conf ${p.confidence}, umur ${Math.round((Date.now() - new Date(p.created_at).getTime()) / 3600000)} jam)`
          )
          .join("\n");

  return `You are a ${params.pair} ${params.timeframe} SNIPER trader using Smart Money Concepts (SMC) + Fibonacci. Goal: entry presisi di level kunci, SL ketat di belakang struktur, TP di tempat yang TEPAT (order block berikutnya / fib extension 1:2, 1:4, 2:5, atau swing) — bukan RR acak. Selektif: hanya trade jika ada konfluensi.

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

POSISI AKTIF (pair ini):
${activeText}

LEARNING FROM MISTAKES - 10 LOSS TERAKHIR:
${lossesText}

WEEKLY LESSON:
${lesson}

RULES (SNIPING):
- Tunggu konfluensi setup: liquidity sweep / ChoCH (change of character) / retest order block + alignment Fibonacci & trend.
- Jika sudah ada posisi aktif SEARAH dengan entry yang berjarak dekat, pilih NO_TRADE (jangan re-entry redundan).
- Jika confidence <70, output NO_TRADE.
- Jangan ulangi pattern loss di atas.
- Entry presisi, dekat price sekarang (max 0.2% deviasi), di zona kunci.
- SL di belakang struktur (sweep low/high atau order block), minimal 0.6*ATR.
- TP di level TEPAT: order block berikutnya, fib extension (1:2 / 1:4 / 2:5), atau swing — tidak harus RR tetap, boleh besar asal level valid.
- Output JSON ONLY, no markdown.

Format JSON:
{
  "direction": "LONG" | "SHORT" | "NO_TRADE",
  "entry": number | null,
  "sl": number | null,
  "tp": number | null,
  "confidence": number (0-100),
  "reasoning": "string max 300 chars, jelaskan setup & level yang dipakai (order block/fib/ChoCH) & lesson applied",
  "rr": number | null
}
`;
}
