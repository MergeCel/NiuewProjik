import { Router } from "express";
import { fetchKlines, fetchCurrentPrice } from "../lib/binance.js";
import { computeIndicators, computeSwingLevels, shouldCallLLM } from "../lib/indicators.js";
import { checkDuplicate, getActivePositions } from "../lib/dedup.js";
import { buildPrompt, callGemini, extractJson } from "../lib/gemini.js";
import { supabase } from "../lib/supabase.js";
import { cronAuth } from "../middleware/auth.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { isSupportedPair, formatPair } from "../lib/pairs.js";

const router = Router();

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
      result: r.outcomes?.result,
      hit: r.outcomes?.hit,
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
          raw_response: { filter },
        })
        .select()
        .single();
      if (error) throw error;
      return res.json({ skipped: true, reason: filter.reason, signal: data, indicators: ind });
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

    // Validate RR if trade
    let status: string = "closed";
    let llmModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    let reasoning = geminiResult.reasoning;

    if (geminiResult.direction !== "NO_TRADE") {
      status = "active";
      // Anti-spam: suppress duplicate entry close in price/time to an existing signal
      const dup = await checkDuplicate(symbol, geminiResult.direction, geminiResult.entry, ind.atr);
      if (dup.duplicate) {
        status = "suppressed";
        llmModel = "dedup-filter";
        reasoning = `Duplicate suppressed: same-direction entry ${dup.existing?.entry} dalam 0.5xATR (${ind.atr?.toFixed(2)}) pada 6 jam terakhir (signal ${dup.existing?.id}). ${geminiResult.reasoning}`;
      }
    }

    const { data, error } = await supabase
      .from("signals")
      .insert({
        pair: symbol,
        timeframe: interval,
        direction: geminiResult.direction,
        entry: geminiResult.entry,
        sl: geminiResult.sl,
        tp: geminiResult.tp,
        confidence: geminiResult.confidence,
        reasoning,
        llm_model: llmModel,
        status,
        raw_prompt: prompt,
        raw_response: geminiResult,
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ signal: data, indicators: ind, gemini: geminiResult, suppressed: status === "suppressed" });
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

    const wins = weekSignals.filter((s: any) => s.outcomes?.[0]?.result === "WIN").length;
    const losses = weekSignals.filter((s: any) => s.outcomes?.[0]?.result === "LOSS").length;
    const winrate = weekSignals.length ? (wins / weekSignals.length) * 100 : 0;

    const summary = `Week ${since.slice(0, 10)}: ${weekSignals.length} signals, ${wins}W/${losses}L, winrate ${winrate.toFixed(1)}%`;
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
      const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-2.5-flash" });
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
