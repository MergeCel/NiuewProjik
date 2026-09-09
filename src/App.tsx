import { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar } from "recharts";

type Signal = {
  id: string;
  created_at: string;
  pair: string;
  timeframe: string;
  direction: string;
  entry: number | null;
  sl: number | null;
  tp: number | null;
  confidence: number;
  reasoning: string;
  status: string;
  outcomes?: any[];
};

type Stats = {
  total: number;
  wins: number;
  losses: number;
  be: number;
  active: number;
  suppressed: number;
  winrate: number;
  pnl: number;
  reflection?: { lesson: string; summary: string; winrate_week: number };
};

export default function App() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");

  const fetchData = async (filter: string = statusFilter) => {
    try {
      const fetchJson = async (url: string) => {
        const r = await fetch(url);
        const text = await r.text();
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${text.slice(0, 200)}`);
        try { return JSON.parse(text); } catch { throw new Error(`API returned HTML (check Vercel deploy / Basic Auth): ${text.slice(0, 120)}`); }
      };
      const params = new URLSearchParams();
      params.set("limit", "100");
      if (filter === "active") params.set("status", "active");
      else if (filter === "suppressed") params.set("status", "suppressed");
      else if (filter === "closed") { params.set("status", "closed"); params.set("trade_only", "1"); }
      else if (filter === "trades") params.set("trade_only", "1");
      else if (filter === "no_trade") params.set("direction", "NO_TRADE");
      else if (filter === "win") params.set("result", "WIN");
      else if (filter === "loss") params.set("result", "LOSS");
      else if (filter === "be") params.set("result", "BE");
      const [sRes, sigRes] = await Promise.all([
        fetchJson("/api/signals/stats"),
        fetchJson(`/api/signals?${params.toString()}`),
      ]);
      if ((sRes as any).error) throw new Error((sRes as any).error);
      setStats(sRes as any);
      setSignals(Array.isArray(sigRes) ? sigRes as any : (sigRes as any).error ? [] : sigRes as any);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const changeStatus = (status: string) => {
    setStatusFilter(status);
  };

  useEffect(() => {
    fetchData();
    const id = setInterval(() => fetchData(), 60000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  if (loading) return <div style={{ padding: 24 }}>Loading...</div>;
  if (error) return <div style={{ padding: 24, color: "#fca5a5" }}>Error: {error} <br/><small>Check Basic Auth / Supabase env</small></div>;

  const chartData = signals
    .slice(0, 20)
    .reverse()
    .map((s) => ({
      time: new Date(s.created_at).toLocaleDateString("id-ID", { month: "short", day: "numeric" }),
      pnl: s.outcomes?.[0]?.pnl_pips ?? 0,
      win: s.outcomes?.[0]?.result === "WIN" ? 1 : 0,
    }));

  // cumulative PnL
  let cum = 0;
  const cumData = chartData.map((d) => {
    cum += d.pnl;
    return { ...d, cum };
  });

  // Evaluation & learning data
  const evaluated = signals.filter((s) => s.outcomes?.[0]);
  const evalWins = evaluated.filter((s) => s.outcomes?.[0]?.result === "WIN").length;
  const evalLosses = evaluated.filter((s) => s.outcomes?.[0]?.result === "LOSS").length;
  const evalBe = evaluated.filter((s) => s.outcomes?.[0]?.result === "BE").length;
  const evalWinrate = evaluated.length ? (evalWins / evaluated.length) * 100 : 0;
  const lastLosses = signals.filter((s) => s.outcomes?.[0]?.result === "LOSS").slice(0, 10);

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, marginBottom: 4 }}>AI Trading Bot — Private Dashboard</h1>
          <p style={{ color: "#9ca3af", fontSize: 13, marginBottom: 16 }}>
            Multi-Pair 15M • Gemini 3.5-flash-lite • Cron 15M •
            <span style={{ color: "#fbbf24" }}> NoIndex Active</span>
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label style={{ fontSize: 13, color: "#9ca3af" }}>Status</label>
          <select
            value={statusFilter}
            onChange={(e) => changeStatus(e.target.value)}
            style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #374151", background: "#1f2937", color: "#e5e7eb", cursor: "pointer" }}
          >
            <option value="ALL">ALL</option>
            <option value="trades">Trades (tanpa NO_TRADE)</option>
            <option value="active">Active</option>
            <option value="suppressed">Suppressed</option>
            <option value="closed">Closed</option>
            <option value="no_trade">NO_TRADE</option>
            <option value="win">WIN</option>
            <option value="loss">LOSS</option>
            <option value="be">BE</option>
          </select>
        </div>
      </div>

      {stats && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 16 }}>
          <div className="card"><div style={{ color: "#9ca3af", fontSize: 12 }}>Total Signals</div><div style={{ fontSize: 22, fontWeight: 700 }}>{stats.total}</div></div>
          <div className="card"><div style={{ color: "#9ca3af", fontSize: 12 }}>Winrate</div><div style={{ fontSize: 22, fontWeight: 700, color: stats.winrate >= 50 ? "#6ee7b7" : "#fca5a5" }}>{stats.winrate}%</div><div style={{ fontSize: 11 }}>{stats.wins}W / {stats.losses}L / {stats.be}BE</div></div>
          <div className="card"><div style={{ color: "#9ca3af", fontSize: 12 }}>P/L Cumulative</div><div style={{ fontSize: 22, fontWeight: 700, color: stats.pnl >= 0 ? "#6ee7b7" : "#fca5a5" }}>{stats.pnl.toFixed(2)}</div></div>
          <div className="card"><div style={{ color: "#9ca3af", fontSize: 12 }}>Active</div><div style={{ fontSize: 22, fontWeight: 700 }}>{stats.active}</div></div>
          <div className="card"><div style={{ color: "#9ca3af", fontSize: 12 }}>Suppressed (anti-spam)</div><div style={{ fontSize: 22, fontWeight: 700, color: "#fbbf24" }}>{stats.suppressed}</div></div>
        </div>
      )}

      {stats?.reflection && (
        <div className="card" style={{ marginBottom: 16, borderColor: "#1e40af" }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>AI Weekly Lesson</div>
          <div style={{ fontSize: 13, color: "#d1d5db" }}>{stats.reflection.lesson}</div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 6 }}>{stats.reflection.summary}</div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <div className="card">
          <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13 }}>Cumulative P/L</div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={cumData}>
              <XAxis dataKey="time" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip />
              <Line type="monotone" dataKey="cum" stroke="#60a5fa" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="card">
          <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13 }}>Win / Loss per Signal</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData}>
              <XAxis dataKey="time" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip />
              <Bar dataKey="pnl" fill="#34d399" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>Hasil Evaluasi & Learning</div>
        <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 8 }}>
          Evaluated: {evaluated.length} • W {evalWins} / L {evalLosses} / BE {evalBe} • Winrate {evalWinrate.toFixed(1)}%
        </div>
        {evaluated.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Waktu</th><th>Pair</th><th>Dir</th><th>Entry</th><th>Exit</th><th>Hit</th><th>Result</th><th>PnL</th>
                </tr>
              </thead>
              <tbody>
                {evaluated.slice(0, 10).map((s) => {
                  const out = s.outcomes?.[0];
                  return (
                    <tr key={s.id}>
                      <td>{new Date(s.created_at).toLocaleString("id-ID")}</td>
                      <td>{s.pair}</td>
                      <td>{s.direction}</td>
                      <td>{s.entry ?? "-"}</td>
                      <td>{out?.exit_price ?? "-"}</td>
                      <td>{out?.hit ?? "-"}</td>
                      <td><span className={`badge ${out?.result === "WIN" ? "badge-win" : out?.result === "LOSS" ? "badge-loss" : ""}`}>{out?.result ?? "-"}</span></td>
                      <td>{out?.pnl_pips?.toFixed(2) ?? "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "#6b7280" }}>Belum ada hasil evaluasi.</div>
        )}

        <div style={{ fontWeight: 700, marginTop: 12, marginBottom: 6, fontSize: 13 }}>
          10 Loss Terakhir yang Dipelajari AI (diinjeksi ke prompt Gemini)
        </div>
        {lastLosses.length > 0 ? (
          lastLosses.map((l) => {
            const out = l.outcomes?.[0];
            return (
              <div key={l.id} style={{ fontSize: 12, color: "#d1d5db", marginBottom: 4 }}>
                <span style={{ color: "#fca5a5", fontWeight: 700 }}>{l.pair} {l.direction}</span> entry {l.entry} → {out?.hit ?? "-"} ({out?.result ?? "-"}) — {l.reasoning?.slice(0, 120)}
              </div>
            );
          })
        ) : (
          <div style={{ fontSize: 13, color: "#6b7280" }}>Belum ada loss.</div>
        )}
      </div>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontWeight: 700 }}>Recent Signals (Entry / SL / TP)</div>
          <button onClick={() => fetchData()} style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #374151", background: "#1f2937", color: "#e5e7eb", cursor: "pointer" }}>Refresh</button>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Waktu</th><th>Pair</th><th>Dir</th><th>Entry</th><th>SL</th><th>TP</th><th>Conf</th><th>Status</th><th>Result</th><th>Reasoning</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((s) => {
                const out = s.outcomes?.[0];
                return (
                  <tr key={s.id}>
                    <td>{new Date(s.created_at).toLocaleString("id-ID")}</td>
                    <td>{s.pair}</td>
                    <td><span className="badge" style={{ background: s.direction === "LONG" ? "#065f46" : s.direction === "SHORT" ? "#7f1d1d" : "#374151", color: "#fff" }}>{s.direction}</span></td>
                    <td>{s.entry ?? "-"}</td>
                    <td>{s.sl ?? "-"}</td>
                    <td>{s.tp ?? "-"}</td>
                    <td>{s.confidence}%</td>
                    <td><span className={`badge ${s.status === "active" ? "badge-active" : s.status === "suppressed" ? "badge-suppressed" : ""}`}>{s.status}</span></td>
                    <td>{out ? <span className={`badge ${out.result === "WIN" ? "badge-win" : out.result === "LOSS" ? "badge-loss" : ""}`}>{out.result} {out.hit ? `(${out.hit})` : ""}</span> : "-"}</td>
                    <td style={{ maxWidth: 260, whiteSpace: "wrap", fontSize: 12 }}>{s.reasoning}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ marginTop: 16, fontSize: 11, color: "#6b7280" }}>
        Cron: Supabase pg_cron 15M → POST /api/cron/analyze (15m sniping, 10 pair) • Evaluate :10/:25/:40/:55 • Anti-spam: entry duplikat searah dalam 6 jam + 0.5xATR ditekan (status suppressed, jadi data belajar AI) • Learning loop injects last 10 losses + weekly lesson into Gemini prompt.
      </div>
    </div>
  );
}