import { Router } from "express";
import { fetchKlines, fetchCurrentPrice } from "../lib/binance.js";
import { computeIndicators, computeSwingLevels, shouldCallLLM, computeAtr, computeSupportResistance, computeFibExtensions } from "../lib/indicators.js";
import type { SRResult } from "../lib/indicators.js";
import { checkDuplicate, getActivePositions } from "../lib/dedup.js";
import { buildPrompt, callGemini, callGroundedGemini, extractJson } from "../lib/gemini.js";
import { fetchFearGreed, fetchCryptoNews } from "../lib/market.js";
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
      .select("lesson, strategy_notes")
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

    // Data sentimen (Fear & Greed + berita) — gratis, tanpa API key terpisah.
    // Hanya diambil saat akan memanggil Gemini.
    const [fearGreedData, newsData] = await Promise.all([fetchFearGreed(), fetchCryptoNews(5)]);

    // HTF bias (4H) + session filter — konteks internasional utk kualitas entry.
    let htf = { trend: "SIDEWAYS" as "UP" | "DOWN" | "SIDEWAYS", price: null as number | null, ema50: null as number | null, ema200: null as number | null };
    try {
      const klines4h = await fetchKlines(symbol, "4h", 200);
      const htfInd = computeIndicators(
        klines4h.map((k) => k.close),
        klines4h.map((k) => k.high),
        klines4h.map((k) => k.low)
      );
      htf = { trend: htfInd.trend, price: htfInd.price, ema50: htfInd.ema50, ema200: htfInd.ema200 };
    } catch (e) {
      console.warn("htf bias fetch failed", e);
    }
    const utcHour = new Date().getUTCHours();
    const session = utcHour >= 7 && utcHour <= 20 ? "HIGH" : "LOW"; // London/NY high-liquidity

    // Zona Support/Resistance dari OHLC (M15 + H4) + target Fibonacci extension.
    const sr15 = computeSupportResistance(closes, highs, lows, ind.atr ?? 0);
    let sr4h: SRResult | null = null;
    try {
      const klines4hForSr = await fetchKlines(symbol, "4h", 200);
      sr4h = computeSupportResistance(
        klines4hForSr.map((k) => k.close),
        klines4hForSr.map((k) => k.high),
        klines4hForSr.map((k) => k.low),
        ind.atr ?? 0
      );
    } catch (e) {
      console.warn("sr4h fetch failed", e);
    }
    const fibExt = computeFibExtensions(swing.swingHigh, swing.swingLow);

    const prompt = buildPrompt({
      pair: formatPair(symbol),
      timeframe: interval,
      price: ind.price,
      rsi: ind.rsi,
      ema50: ind.ema50,
      ema200: ind.ema200,
      atr: ind.atr,
      trend: ind.trend,
      htfBias: htf.trend,
      htfPrice: htf.price,
      htfEma50: htf.ema50,
      htfEma200: htf.ema200,
      session,
      swingHigh: swing.swingHigh,
      swingLow: swing.swingLow,
      fib: swing.fib,
      fibExt,
      support15: sr15.nearestSupport?.price ?? null,
      resistance15: sr15.nearestResistance?.price ?? null,
      support15Strength: sr15.nearestSupport?.strength ?? null,
      resistance15Strength: sr15.nearestResistance?.strength ?? null,
      support4h: sr4h?.nearestSupport?.price ?? null,
      resistance4h: sr4h?.nearestResistance?.price ?? null,
      support4hStrength: sr4h?.nearestSupport?.strength ?? null,
      resistance4hStrength: sr4h?.nearestResistance?.strength ?? null,
      activePositions,
      recentLosses: losses,
      weeklyLesson: reflection?.lesson || null,
      strategyNotes: reflection?.strategy_notes || null,
      fearGreed: fearGreedData,
      news: newsData,
      klinesSummary: last5,
    });

    const geminiResult = await callGemini(prompt);
    const gem = geminiResult.signal;

    // --- Risk Guard: SL floor (1.5×ATR + S/R) & TP re-target struktural (RR ≥ 1.2) ---
    // Gemini bebas menentukan SL selama >= floor; SL terlalu ketat (<1.5×ATR / di dalam zona S/R)
    // rentan false breakout. Bila SL diperlebar merusak RR, TP ditarget ulang ke level struktural
    // (S/R M15/H4, Fib extension, swing). Tanpa target valid -> NO_TRADE.
    let slAdjusted = false;
    let tpAdjusted = false;
    let riskNote = "";
    let rejectReason: string | null = null;
    let rrValue: number | null = null;
    let origSl: number | null = null;
    let origTp: number | null = null;
    if (gem.direction === "LONG" || gem.direction === "SHORT") {
      const atrVal = ind.atr;
      if (atrVal && atrVal > 0 && gem.entry != null) {
        const entry = gem.entry;
        const isLong = gem.direction === "LONG";
        const nearZone = isLong ? sr15.nearestSupport : sr15.nearestResistance;
        const structureDist = nearZone
          ? isLong
            ? Math.max(0, entry - (nearZone.price - 0.25 * atrVal))
            : Math.max(0, (nearZone.price + 0.25 * atrVal) - entry)
          : 0;
        // Floor SL: minimal 1.5×ATR; di belakang zona S/R terdekat jika lebih jauh.
        let minSlDist = Math.max(1.5 * atrVal, structureDist);
        // Cap 3×ATR: diizinkan melebihi HANYA jika struktur S/R membenarkan (structureDist).
        if (minSlDist > 3 * atrVal && structureDist <= 3 * atrVal) minSlDist = 3 * atrVal;

        const curDist = gem.sl == null ? 0 : isLong ? entry - gem.sl : gem.sl - entry;
        origSl = gem.sl;
        origTp = gem.tp;
        if (gem.sl == null || curDist < minSlDist) {
          gem.sl = isLong ? entry - minSlDist : entry + minSlDist;
          slAdjusted = true;
        }
        const risk = Math.abs(entry - gem.sl);
        rrValue = gem.tp != null && risk > 0 ? Math.abs(gem.tp - entry) / risk : 0;

        if (rrValue < 1.2) {
          // Cari target struktural terdekat yang mengembalikan RR ≥ 1.2.
          const ext = isLong ? fibExt.up : fibExt.down;
          const candidates: { price: number | null; label: string }[] = isLong
            ? [
                { price: sr15.nearestResistance?.price ?? null, label: "S/R M15" },
                { price: sr4h?.nearestResistance?.price ?? null, label: "S/R H4" },
                { price: ext.tp1272, label: "Fib 1.272" },
                { price: ext.tp1414, label: "Fib 1.414" },
                { price: ext.tp1618, label: "Fib 1.618" },
                { price: ext.tp200, label: "Fib 2.0" },
                { price: swing.swingHigh, label: "Swing High" },
              ]
            : [
                { price: sr15.nearestSupport?.price ?? null, label: "S/R M15" },
                { price: sr4h?.nearestSupport?.price ?? null, label: "S/R H4" },
                { price: ext.tp1272, label: "Fib 1.272" },
                { price: ext.tp1414, label: "Fib 1.414" },
                { price: ext.tp1618, label: "Fib 1.618" },
                { price: ext.tp200, label: "Fib 2.0" },
                { price: swing.swingLow, label: "Swing Low" },
              ];
          const valid = candidates
            .filter(
              (c) =>
                c.price != null &&
                (isLong ? c.price > entry : c.price < entry) &&
                Math.abs(c.price - entry) / risk >= 1.2
            )
            .sort((a, b) => Math.abs((a.price as number) - entry) - Math.abs((b.price as number) - entry));

          if (valid.length > 0) {
            gem.tp = valid[0].price as number;
            tpAdjusted = true;
            riskNote = `TP ditarget ulang ke ${valid[0].label} (${gem.tp}) agar RR≥1.2 (SL floor ${minSlDist.toFixed(2)} = ${(minSlDist / atrVal).toFixed(1)}×ATR).`;
          } else {
            rejectReason = `RR ${rrValue.toFixed(2)} < 1.2 setelah SL floor ${minSlDist.toFixed(2)} (${(minSlDist / atrVal).toFixed(1)}×ATR); tidak ada target struktural (S/R M15/H4, Fib ext, swing) yang memulihkan RR. Entry dibatalkan.`;
          }
        } else if (slAdjusted) {
          riskNote = `SL diperlebar ke floor (${minSlDist.toFixed(2)} = ${(minSlDist / atrVal).toFixed(1)}×ATR + S/R) agar tahan false breakout; RR ${rrValue.toFixed(2)} tetap terjaga.`;
        }
      }
    }

    // Jika risk guard menolak -> ubah jadi NO_TRADE transparan (bukan suppress).
    if (rejectReason) {
      gem.direction = "NO_TRADE";
      gem.entry = null;
      gem.sl = null;
      gem.tp = null;
      gem.reasoning = `${gem.reasoning}\n[RR-REJECT] ${rejectReason}`;
    }

    // Validate RR if trade
    let status: string = "closed";
    let llmModel = rejectReason ? "rr-filter" : geminiResult.model;
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

    // Catatan risk guard di reasoning (transparan di dashboard & learning).
    if (slAdjusted || tpAdjusted) reasoning = `${reasoning}\n[RISK-GUARD] ${riskNote}`;

    const srSnapshot = {
      support15: sr15.nearestSupport ? { price: sr15.nearestSupport.price, strength: sr15.nearestSupport.strength } : null,
      resistance15: sr15.nearestResistance ? { price: sr15.nearestResistance.price, strength: sr15.nearestResistance.strength } : null,
      support4h: sr4h?.nearestSupport ? { price: sr4h.nearestSupport.price, strength: sr4h.nearestSupport.strength } : null,
      resistance4h: sr4h?.nearestResistance ? { price: sr4h.nearestResistance.price, strength: sr4h.nearestResistance.strength } : null,
    };
    const riskSnapshot = {
      atr: ind.atr,
      sr: srSnapshot,
      fibExt,
      rr: rrValue,
      slAdjusted,
      tpAdjusted,
      rejected: !!rejectReason,
      origSl,
      origTp,
    };

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
        raw_response: isOverride
          ? { ...gem, ...riskSnapshot, override: true }
          : { ...gem, ...riskSnapshot },
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

    // Idempotency guard: ambil outcome yang sudah ada untuk signal aktif ini,
    // supaya signal yang gagal ditutup sebelumnya tidak menghasilkan outcome ganda.
    const { data: existingOutcomes } = await supabase
      .from("outcomes")
      .select("signal_id")
      .in("signal_id", active.map((s) => s.id));
    const existingSet = new Set((existingOutcomes || []).map((o: any) => o.signal_id));

    // Deteksi SL/TP pakai sentuhan candle (wick high/low) sejak entry — stop-trigger
    // semantics. Harga live saja melewatkan wick yang menyentuh SL/TP lalu recovery
    // sebelum tick evaluasi berikutnya (bug: "kena SL di chart tapi tidak closed").
    const klines = await fetchKlines(symbol, "15m", 300).catch((e) => {
      console.error("evaluate: klines fetch failed, live-price fallback", e);
      return [];
    });

    const results: any[] = [];
    for (const sig of active) {
      if (sig.sl == null || sig.tp == null) continue; // tak bisa evaluasi tanpa SL/TP

      const createdMs = new Date(sig.created_at).getTime();
      const candles = klines.filter((k) => k.closeTime >= createdMs);

      let hit: "SL" | "TP" | null = null;

      // Sentuhan level dari high/low candle (termasuk candle yang sedang berjalan).
      const firstSl = candles.find((k) =>
        sig.direction === "LONG" ? k.low <= sig.sl : k.high >= sig.sl
      );
      const firstTp = candles.find((k) =>
        sig.direction === "LONG" ? k.high >= sig.tp : k.low <= sig.tp
      );
      // Jika SL & TP sama-sama tersentuh: pakai yang candle-nya lebih awal;
      // candle sama -> SL menang (konservatif).
      if (firstSl && (!firstTp || firstSl.openTime <= firstTp.openTime)) hit = "SL";
      else if (firstTp) hit = "TP";

      // Fallback: harga live saat ini melewati level (klines gagal / level di gap).
      if (!hit) {
        if (sig.direction === "LONG") {
          if (price <= sig.sl) hit = "SL";
          else if (price >= sig.tp) hit = "TP";
        } else if (sig.direction === "SHORT") {
          if (price >= sig.sl) hit = "SL";
          else if (price <= sig.tp) hit = "TP";
        }
      }

      if (hit) {
        // Exit di harga level yang tersentuh (isi stop order), bukan harga live.
        const exitPrice = hit === "SL" ? sig.sl : sig.tp;
        const result: "WIN" | "LOSS" = hit === "SL" ? "LOSS" : "WIN";
        if (existingSet.has(sig.id)) {
          // Sudah dievaluasi sebelumnya (penutupan sempat gagal) -> cukup tutup, tanpa outcome ganda.
          const { error: closeErr } = await supabase
            .from("signals")
            .update({ status: "closed" })
            .eq("id", sig.id);
          if (closeErr) console.error("evaluate: close already-evaluated signal failed", sig.id, closeErr.message);
          results.push({ id: sig.id, hit, result, price: exitPrice, skipped: "already-evaluated" });
          continue;
        }
        const pnl = sig.direction === "LONG" ? exitPrice - sig.entry : sig.entry - exitPrice;
        const risk = Math.abs(sig.entry - sig.sl);
        const pnlR = risk > 0 ? (sig.direction === "LONG" ? (exitPrice - sig.entry) / risk : (sig.entry - exitPrice) / risk) : 0;
        const { error: outErr } = await supabase.from("outcomes").insert({
          signal_id: sig.id,
          result,
          exit_price: exitPrice,
          pnl_pips: pnl,
          pnl_r: pnlR,
          hit,
        });
        if (outErr) throw outErr;

        const { error: closeErr } = await supabase
          .from("signals")
          .update({ status: "closed" })
          .eq("id", sig.id);
        if (closeErr) console.error("evaluate: close signal failed", sig.id, closeErr.message);
        results.push({ id: sig.id, hit, result, price: exitPrice });
      }
    }

    // Also close stale signals >48h
    const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const stale = (active || []).filter((s) => s.created_at < cutoff && !results.find((r) => r.id === s.id));
    for (const s of stale) {
      if (existingSet.has(s.id)) {
        const { error: closeErr } = await supabase
          .from("signals")
          .update({ status: "closed" })
          .eq("id", s.id);
        if (closeErr) console.error("evaluate: close stale already-evaluated signal failed", s.id, closeErr.message);
        results.push({ id: s.id, hit: "TIMEOUT", result: "BE", skipped: "already-evaluated" });
        continue;
      }
      const { error: outErr } = await supabase.from("outcomes").insert({
        signal_id: s.id,
        result: "BE",
        exit_price: price,
        pnl_pips: 0,
        pnl_r: 0,
        hit: "TIMEOUT",
      });
      if (outErr) throw outErr;
      const { error: closeErr } = await supabase
        .from("signals")
        .update({ status: "closed" })
        .eq("id", s.id);
      if (closeErr) console.error("evaluate: close stale signal failed", s.id, closeErr.message);
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

    // Metrik SL-width (dari ATR tersimpan di raw_response) — mendeteksi pola tight-SL -> false breakout.
    const slWidths = (weekSignals || [])
      .filter(
        (s: any) =>
          (s.direction === "LONG" || s.direction === "SHORT") &&
          s.outcomes?.[0] &&
          s.raw_response?.atr &&
          s.entry &&
          s.sl
      )
      .map((s: any) => ({
        result: s.outcomes[0].result,
        width: Math.abs(Number(s.entry) - Number(s.sl)) / Number(s.raw_response.atr),
      }));
    const median = (arr: number[]) => (arr.length ? arr[Math.floor(arr.length / 2)] : null);
    const lossWidths = slWidths.filter((w) => w.result === "LOSS").map((w) => w.width).sort((a, b) => a - b);
    const winWidths = slWidths.filter((w) => w.result === "WIN").map((w) => w.width).sort((a, b) => a - b);
    const slMetric = slWidths.length
      ? `SL width (×ATR): LOSS median ${median(lossWidths)?.toFixed(2) ?? "n/a"} (n=${lossWidths.length}); WIN median ${median(winWidths)?.toFixed(2) ?? "n/a"} (n=${winWidths.length}); LOSS dengan SL<1.5×ATR: ${lossWidths.filter((w) => w < 1.5).length}.`
      : "SL width metric: n/a (belum ada signal dengan ATR tersimpan).";
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

    // Evaluasi strategi via Gemini dengan Google Search grounding (berita/YouTube/web).
    // Membandingkan praktik terbaik SMC/Fib sniping dengan cara bot trading minggu ini.
    const [fearGreedData, newsData] = await Promise.all([fetchFearGreed(), fetchCryptoNews(5)]);
    let strategyNotes = null;
    try {
      const groundedPrompt = `You are a crypto trading strategist. Using Google Search, research INTERNATIONAL (global, not only Indonesia) best-practice rules for BTC/altcoin 15m sniping trading: Smart Money Concepts (liquidity sweep, order block, Change of Character), Fibonacci retracement/extension sniping, risk management, and avoiding over-trading. Cross-check the video/blog strategies you find against current global market conditions (news, Fear & Greed).

Then evaluate the strategy this bot applied this week.

Bot week summary: ${summary}
SL width analysis: ${slMetric}
Fear & Greed: ${fearGreedData ? `${fearGreedData.value} (${fearGreedData.classification})` : "n/a"}
Top news: ${newsData.slice(0, 3).map((n) => n.title).join(" | ") || "none"}
Trades this week:
${JSON.stringify(
  weekSignals.slice(0, 20).map((s: any) => ({
    dir: s.direction,
    entry: s.entry,
    sl: s.sl,
    tp: s.tp,
    conf: s.confidence,
    reasoning: s.reasoning,
    outcome: s.outcomes?.[0],
  }))
)}

Provide: (1) what the bot is doing right, (2) the biggest repeated mistake patterns, (3) 3-5 CONCRETE RULE adjustments for next week.

IMPORTANT OUTPUT RULES:
- Write adjustments as CONDITIONAL recommendations ("consider doing X IF data shows Y"), NOT absolute prohibitions. NEVER output a rule like "disable all shorts when Fear & Greed > 70" or "lockout for 4 hours" as a hard law.
- Explicitly weigh the trade-off: being too selective risks missing valid signals. Only recommend restraint where the bot's OWN loss data clearly shows the mistake.
- Ground recommendations in the actual trades above, and mention which international strategy sources you compared.
- Max 1200 chars, plain text.`;
      const grounded = await callGroundedGemini(groundedPrompt);
      strategyNotes = grounded.text.slice(0, 2000);
    } catch (e) {
      console.warn("reflect grounded eval fail", e);
    }

    const { data, error } = await supabase
      .from("ai_reflections")
      .insert({
        week_start: new Date().toISOString().slice(0, 10),
        summary,
        lesson,
        strategy_notes: strategyNotes,
        winrate_week: winrate,
      })
      .select()
      .single();
    if (error) throw error;

    res.json({ reflection: data, grounded: !!strategyNotes });
  } catch (e: any) {
    console.error("reflect error", e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
