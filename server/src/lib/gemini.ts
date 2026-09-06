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

const MODEL_FALLBACKS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3-flash-preview"];

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

export async function callGemini(prompt: string, modelOverride?: string): Promise<GeminiSignal> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY missing");

  const preferred = modelOverride || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const modelsToTry = [preferred, ...MODEL_FALLBACKS.filter((m) => m !== preferred)];

  let lastError: any;
  for (const modelName of modelsToTry) {
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
      return parsed;
    } catch (e) {
      lastError = e;
      console.warn(`Gemini model ${modelName} failed:`, (e as Error).message);
      // treat truncated/invalid output as NO_TRADE so analyze still succeeds
      const msg = String((e as Error).message);
      if (msg.includes("Unterminated string") || msg.includes("Expected")) {
        return { direction: "NO_TRADE", entry: null, sl: null, tp: null, confidence: 0, reasoning: `Gemini ${modelName} returned invalid JSON; treated as no-trade`, rr: null };
      }
      // try next fallback
      if (msg.includes("429")) {
        // rate limit, wait briefly
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  throw new Error(`All Gemini models failed. Last: ${lastError?.message}`);
}

export function buildPrompt(params: {
  pair: string;
  price: number;
  rsi: number | null;
  ema50: number | null;
  ema200: number | null;
  atr: number | null;
  trend: string;
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

  return `You are a ${params.pair} 1H swing trader. Task: provide entry, stop loss, take profit ONLY if confidence >=70. RR minimal 1:1.5.

MARKET DATA (Binance 1H, ${params.pair}):
Price: ${params.price}
RSI(14): ${params.rsi?.toFixed(2) ?? "n/a"}
EMA50: ${params.ema50?.toFixed(2) ?? "n/a"}
EMA200: ${params.ema200?.toFixed(2) ?? "n/a"}
ATR(14): ${params.atr?.toFixed(2) ?? "n/a"}
Trend (EMA50 vs EMA200): ${params.trend}
Recent klines: ${params.klinesSummary}

LEARNING FROM MISTAKES - 10 LOSS TERAKHIR:
${lossesText}

WEEKLY LESSON:
${lesson}

RULES:
- Jika confidence <70, output NO_TRADE.
- Jangan ulangi pattern loss di atas (misal counter-trend, SL terlalu ketat <0.8*ATR, TP tidak realistis).
- SL minimal 0.8*ATR, TP minimal 1.2*ATR, RR >=1.5
- Entry harus dekat price sekarang (max 0.3% deviasi).
- Output JSON ONLY, no markdown.

Format JSON:
{
  "direction": "LONG" | "SHORT" | "NO_TRADE",
  "entry": number | null,
  "sl": number | null,
  "tp": number | null,
  "confidence": number (0-100),
  "reasoning": "string max 300 chars, jelaskan kenapa & lesson applied",
  "rr": number | null
}
`;
}
