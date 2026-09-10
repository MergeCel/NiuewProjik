import { Router } from "express";
import { fetchKlines, fetchCurrentPrice } from "../lib/binance.js";
import { computeIndicators, computeSwingLevels, shouldCallLLM, computeAtr } from "../lib/indicators.js";
import { checkDuplicate, getActivePositions } from "../lib/dedup.js";
import { buildPrompt, callGemini, extractJson } from "../lib/gemini.js";
import { supabase } from "../lib/supabase.js";
import { cronAuth } from "../middleware/auth.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { isSupportedPair, formatPair } from "../lib/pairs.js";

const router = Router();

// NO_TRADE tidak memengaruhi pembelajaran (learning hanya dari outcomes LOSS),
// jadi batasi penyimpanan agar DB tidak penuh dengan baris NO_TRADE.
const KEEP_NO_TRADE = 500;

// Cooldown per-pair: jika analisis terakhir (bukan baris cooldown) pair ini adalah
// NO_TRADE atau suppressed dalam jendela ini, lewati panggilan Gemini.
// Gemini free-tier punya batas RPD per model; tanpa throttle, 10 pair x 96 siklus/hari
// membakar kuota dan memicu burst 429 ("Gemini models unavailable").
const NO_TRADE_COOLDOWN_MIN = Number(process.env.NO_TRADE_COOLDOWN_MIN) || 60;

// Override breakout dalam jendela cooldown: panggil Gemini tetap jika harga bergerak
// melebihi COOLDOWN_OVERRIDE_ATR x ATR(timeframe lebih tinggi, 1H = baseline stabil).
// Hysteresis: setelah override, threshold naik ke COOLDOWN_OVERRIDE_ATR_HYST sebelum
// boleh trigger lagi (mencegah re-trigger untuk pergerakan yang sama / whipsaw).
// Cap: maksimal OVERRIDE_CAP_PER_HOUR override per jam per pair (anti-choppy).
const COOLDOWN_OVERRIDE_ATR = Number(process.env.COOLDOWN_OVERRIDE_ATR) || 0.5;
const COOLDOWN_OVERRIDE_ATR_HYST = Number(process.env.COOLDOWN_OVERRIDE_ATR_HYST) || 0.7;
const OVERRIDE_CAP_PER_HOUR = Number(process.env.OVERRIDE_CAP_PER_HOUR) || 3;

// POST /api/cron/analyze - create new signal (15m sniping)
router.post("/analyze", cronAuth, async (req, res) => {
  const symbol = ((req.query.symbol as string) || "BTCUSDT").toUpperCase();
  const interval = (req.query.interval as string) || "15m";
  try {
    if (!isSupportedPair(symbol)) {
      return res.status(400).json({ error: `Unsupported pair ${symbol}` });
    }
    const klines = await fetchKlines(symbol, interval, 200);
    const closes = klines.map((k) => k.close);
    const highs = klines.map((k) => k.high);
    const lows = klines.map((k) => k.low);

    const ind = computeIndicators(closes, highs, lows);
    const filter = shouldCallLLM(ind);
    const swing = computeSwingLevels(closes);
    const activePositions = filter.call ? await getActivePositions(symbol) : [];

    // Fetch learning data
    const { data: recentLosses } = await supabase
      .from("signals")
      .select("*, outcomes!inner(result, hit)")
      .eq("outcomes.result", "LOSS")
      .order("created_at", { ascending: false })
      .limit(10);

    const { data: reflection } = await supabase
      .from("ai_reflections")
      .select("lesson")
      .order("week_start", { ascending: false })
      .limit(1)
      .maybeSingle();

    const losses = (recentLosses || []).map((r: any) => ({
      direction: r.direction,
      entry: r.entry,
      sl: r.sl,
      tp: r.tp,
      result: r.outcomes?.[0]?.result,
      hit: r.outcomes?.[0]?.hit,
      reasoning: r.reasoning,
    }));

    // Klines summary for prompt (last 5 closes)
    const last5 = klines.slice(-5).map((k) => k.close.toFixed(2)).join(" -> ");

    if (!filter.call) {
      // Save NO_TRADE without calling Gemini to save quota
      const { data, error } = await supabase
        .from("signals")
        .insert({
          pair: symbol,
          timeframe: interval,
          direction: "NO_TRADE",
          entry: null,
          sl: null,
          tp: null,
          confidence: 0,
          reasoning: `Pre-filter skip: ${filter.reason}`,
          llm_model: "pre-filter",
          status: "closed",
          raw_response: { filter, price: ind.price },
        })
        .select()
        .single();
      if (error) throw error;
      return res.json({ skipped: true, reason: filter.reason, signal: data, indicators: ind });
    }

    // Cooldown check: analisis terakhir pair ini (NO_TRADE / suppressed) masih baru?
    // Jika ya, lewati Gemini UNLESS harga bergerak signifikan dari baseline
    // (breakout/sweep) melewati threshold ATR adaptif dari timeframe 1H.
    const { data: lastSig } = await supabase
      .from("signals")
      .select("direction, status, created_at, entry, raw_response")
      .eq("pair", symbol)
      .neq("llm_model", "cooldown")
      .order("created_at", { ascending: false })
      .limit(1);
    const lastSignal = lastSig?.[0];
    const cooldownMs = NO_TRADE_COOLDOWN_MIN * 60000;
    let isOverride = false;
    if (
      lastSignal &&
      (lastSignal.direction === "NO_TRADE" || lastSignal.status === "suppressed") &&
      Date.now() - new Date(lastSignal.created_at).getTime() < cooldownMs
    ) {
      // Override breakout: analisis tetap jika pergerakan melewati threshold ATR(1H).
      const refPrice = lastSignal.raw_response?.price ?? lastSignal.entry;
      let moveOk = false;
      if (refPrice && ind.price) {
        const absMove = Math.abs(ind.price - refPrice);
        const klines1h = await fetchKlines(symbol, "1h", 200);
        const atr1h = computeAtr(
          klines1h.map((k) => k.high),
          klines1h.map((k) => k.low),
          klines1h.map((k) => k.close)
        );
        // Hysteresis: threshold naik jika analisis terakhir adalah hasil override.
        const lastWasOverride = lastSignal.raw_response?.override === true;
        const atrMult = lastWasOverride ? COOLDOWN_OVERRIDE_ATR_HYST : COOLDOWN_OVERRIDE_ATR;
        const threshold = (atr1h ?? ind.atr ?? ind.price * 0.002) * atrMult;
        if (absMove > threshold) {
          // Cap: maksimal OVERRIDE_CAP_PER_HOUR override per jam per pair.
          const cutoff = new Date(Date.now() - 60 * 60000).toISOString();
          const { count: ovrCount } = await supabase
            .from("signals")
            .select("id", { count: "exact", head: true })
            .eq("pair", symbol)
            .gte("created_at", cutoff)
            .filter("raw_response->>override", "eq", "true");
          if (!ovrCount || ovrCount < OVERRIDE_CAP_PER_HOUR) {
            moveOk = true;
          }
        }
      }
      if (!moveOk) {
        return res.json({
          skipped: true,
          reason: `cooldown (${symbol} NO_TRADE/suppressed ${NO_TRADE_COOLDOWN_MIN}m lalu)`,
          indicators: ind,
        });
      }
      isOverride = true;
    }

    const prompt = buildPrompt({
      pair: formatPair(symbol),
      timeframe: interval,
      price: ind.price,
      rsi: ind.rsi,
      ema50: ind.ema50,
      ema200: ind.ema200,
      atr: ind.atr,
      trend: ind.trend,
      swingHigh: swing.swingHigh,
      swingLow: swing.swingLow,
      fib: swing.fib,
      activePositions,
      recentLosses: losses,
      weeklyLesson: reflection?.lesson || null,
      klinesSummary: last5,
    });

    const geminiResult = await callGemini(prompt);
    const gem = geminiResult.signal;

    // Validate RR if trade
    let status: string = "closed";
    let llmModel = geminiResult.model;
    let reasoning = gem.reasoning;

    if (gem.direction !== "NO_TRADE") {
      status = "active";
      // Anti-spam: suppress duplicate entry close in price/time to an existing signal
      const dup = await checkDuplicate(symbol, gem.direction, gem.entry, ind.atr);
      if (dup.duplicate) {
        status = "suppressed";
        llmModel = "dedup-filter";
        reasoning = `Duplicate suppressed: same-direction entry ${dup.existing?.entry} dalam 0.5xATR (${ind.atr?.toFixed(2)}) pada 6 jam terakhir (signal ${dup.existing?.id}). ${gem.reasoning}`;
      }
    }

    const { data, error } = await supabase
      .from("signals")
      .insert({
        pair: symbol,
        timeframe: interval,
        direction: gem.direction,
        entry: gem.entry,
        sl: gem.sl,
        tp: gem.tp,
        confidence: gem.confidence,
        reasoning,
        llm_model: llmModel,
        status,
        raw_prompt: prompt,
        raw_response: isOverride ? { ...gem, price: ind.price, override: true } : { ...gem, price: ind.price },
      })
      .select()
      .single();

    if (error) throw error;

    // Batasi penyimpanan NO_TRADE: hapus yang paling lama jika melebihi cap,
    // sehingga hanya ~KEEP_NO_TRADE terbaru yang tersimpan.
    if (gem.direction === "NO_TRADE") {
      try {
        const { count } = await supabase
          .from("signals")
          .select("id", { count: "exact", head: true })
          .eq("direction", "NO_TRADE");
        if (count && count > KEEP_NO_TRADE) {
          const excess = count - KEEP_NO_TRADE;
          const { data: old } = await supabase
            .from("signals")
            .select("id")
            .eq("direction", "NO_TRADE")
            .order("created_at", { ascending: true })
            .limit(excess);
          if (old && old.length) {
            await supabase.from("signals").delete().in(
              "id",
              old.map((o: any) => o.id)
            );
          }
        }
      } catch (trimErr) {
        console.error("trim NO_TRADE error", trimErr);
      }
    }

    res.json({ signal: data, indicators: ind, gemini: gem, suppressed: status === "suppressed" });
  } catch (e: any) {
    console.error("analyze error", e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/cron/evaluate - check active signals hit SL/TP
router.post("/evaluate", cronAuth, async (req, res) => {
  const symbol = ((req.query.symbol as string) || "BTCUSDT").toUpperCase();
  try {
    if (!isSupportedPair(symbol)) {
      return res.status(400).json({ error: `Unsupported pair ${symbol}` });
    }
    const price = await fetchCurrentPrice(symbol);
    const { data: active, error } = await supabase
      .from("signals")
      .select("*")
      .eq("status", "active")
      .eq("pair", symbol)
      .order("created_at", { ascending: true });

    if (error) throw error;
    if (!active || active.length === 0) return res.json({ price, evaluated: 0 });

    const results: any[] = [];
    for (const sig of active) {
      let hit: "SL" | "TP" | null = null;
      let result: "WIN" | "LOSS" | null = null;

      if (sig.direction === "LONG") {
        if (price <= sig.sl) {
          hit = "SL";
          result = "LOSS";
        } else if (price >= sig.tp) {
          hit = "TP";
          result = "WIN";
        }
      } else if (sig.direction === "SHORT") {
        if (price >= sig.sl) {
          hit = "SL";
          result = "LOSS";
        } else if (price <= sig.tp) {
          hit = "TP";
          result = "WIN";
        }
      }

      if (hit && result) {
        // Check timeout - if signal older than 48h without hit, mark BE
        const pnl = sig.direction === "LONG" ? price - sig.entry : sig.entry - price;
        const { error: outErr } = await supabase.from("outcomes").insert({
          signal_id: sig.id,
          result,
          exit_price: price,
          pnl_pips: pnl,
          hit,
        });
        if (outErr) throw outErr;

        await supabase.from("signals").update({ status: "closed" }).eq("id", sig.id);
        results.push({ id: sig.id, hit, result, price });
      }
    }

    // Also close stale signals >48h
    const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const stale = (active || []).filter((s) => s.created_at < cutoff && !results.find((r) => r.id === s.id));
    for (const s of stale) {
      const priceNow = price;
      await supabase.from("outcomes").insert({
        signal_id: s.id,
        result: "BE",
        exit_price: priceNow,
        pnl_pips: 0,
        hit: "TIMEOUT",
      });
      await supabase.from("signals").update({ status: "closed" }).eq("id", s.id);
      results.push({ id: s.id, hit: "TIMEOUT", result: "BE" });
    }

    res.json({ price, evaluated: results.length, results });
  } catch (e: any) {
    console.error("evaluate error", e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/cron/reflect - weekly learning
router.post("/reflect", cronAuth, async (req, res) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { data: weekSignals } = await supabase
      .from("signals")
      .select("*, outcomes(result, hit, pnl_pips)")
      .gte("created_at", since)
      .order("created_at", { ascending: true });

    if (!weekSignals || weekSignals.length === 0) {
      return res.json({ message: "No signals this week" });
    }

    const tradeSignals = weekSignals.filter((s: any) => s.direction === "LONG" || s.direction === "SHORT");
    const wins = tradeSignals.filter((s: any) => s.outcomes?.[0]?.result === "WIN").length;
    const losses = tradeSignals.filter((s: any) => s.outcomes?.[0]?.result === "LOSS").length;
    const suppressedCount = weekSignals.filter((s: any) => s.status === "suppressed").length;
    const winrate = tradeSignals.length ? (wins / tradeSignals.length) * 100 : 0;

    const summary = `Week ${since.slice(0, 10)}: ${tradeSignals.length} trades, ${wins}W/${losses}L, winrate ${winrate.toFixed(1)}% (${suppressedCount} suppressed by anti-spam)`;
    const lessonPrompt = `You are trading coach. Analyze this week trades:\n${JSON.stringify(
      weekSignals.slice(0, 20).map((s: any) => ({
        dir: s.direction,
        entry: s.entry,
        sl: s.sl,
        tp: s.tp,
        conf: s.confidence,
        reasoning: s.reasoning,
        outcome: s.outcomes?.[0],
      }))
    )}\nProvide 1 concise lesson (max 400 chars) to avoid repeating losses and what to improve. JSON: {"lesson":"..."}`;

    let lesson = "No lesson generated";
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
      const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite" });
      const result = await model.generateContent(lessonPrompt);
      const text = result.response.text();
      const parsed = JSON.parse(extractJson(text));
      lesson = parsed.lesson || text.slice(0, 500);
    } catch (e) {
      console.warn("reflect gemini fail", e);
      lesson = `Auto lesson: winrate ${winrate.toFixed(1)}%, avoid low confidence trades`;
    }

    const { data, error } = await supabase
      .from("ai_reflections")
      .insert({
        week_start: new Date().toISOString().slice(0, 10),
        summary,
        lesson,
        winrate_week: winrate,
      })
      .select()
      .single();
    if (error) throw error;

    res.json({ reflection: data });
  } catch (e: any) {
    console.error("reflect error", e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
