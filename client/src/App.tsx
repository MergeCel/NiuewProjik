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
  winrate: number;
  pnl: number;
  reflection?: { lesson: string; summary: string; winrate_week: number };
};

export default function App() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = async () => {
    try {
      const [sRes, sigRes] = await Promise.all([
        fetch("/api/signals/stats").then((r) => r.json()),
        fetch("/api/signals?limit=50").then((r) => r.json()),
      ]);
      if (sRes.error) throw new Error(sRes.error);
      setStats(sRes);
      setSignals(Array.isArray(sigRes) ? sigRes : sigRes.error ? [] : sigRes);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 60000);
    return () => clearInterval(id);
  }, []);

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

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 20 }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>BTC Trading Bot — Private Dashboard</h1>
      <p style={{ color: "#9ca3af", fontSize: 13, marginBottom: 16 }}>
        Pair BTCUSDT 1H • Gemini {(import.meta as any).env?.VITE_GEMINI_MODEL || "2.0-flash"} • Cron 1H •
        <span style={{ color: "#fbbf24" }}> NoIndex Active</span>
      </p>

      {stats && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 16 }}>
          <div className="card"><div style={{ color: "#9ca3af", fontSize: 12 }}>Total Signals</div><div style={{ fontSize: 22, fontWeight: 700 }}>{stats.total}</div></div>
          <div className="card"><div style={{ color: "#9ca3af", fontSize: 12 }}>Winrate</div><div style={{ fontSize: 22, fontWeight: 700, color: stats.winrate >= 50 ? "#6ee7b7" : "#fca5a5" }}>{stats.winrate}%</div><div style={{ fontSize: 11 }}>{stats.wins}W / {stats.losses}L / {stats.be}BE</div></div>
          <div className="card"><div style={{ color: "#9ca3af", fontSize: 12 }}>P/L Cumulative</div><div style={{ fontSize: 22, fontWeight: 700, color: stats.pnl >= 0 ? "#6ee7b7" : "#fca5a5" }}>{stats.pnl.toFixed(2)}</div></div>
          <div className="card"><div style={{ color: "#9ca3af", fontSize: 12 }}>Active</div><div style={{ fontSize: 22, fontWeight: 700 }}>{stats.active}</div></div>
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

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontWeight: 700 }}>Recent Signals (Entry / SL / TP)</div>
          <button onClick={fetchData} style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #374151", background: "#1f2937", color: "#e5e7eb", cursor: "pointer" }}>Refresh</button>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Waktu</th><th>Dir</th><th>Entry</th><th>SL</th><th>TP</th><th>Conf</th><th>Status</th><th>Result</th><th>Reasoning</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((s) => {
                const out = s.outcomes?.[0];
                return (
                  <tr key={s.id}>
                    <td>{new Date(s.created_at).toLocaleString("id-ID")}</td>
                    <td><span className="badge" style={{ background: s.direction === "LONG" ? "#065f46" : s.direction === "SHORT" ? "#7f1d1d" : "#374151", color: "#fff" }}>{s.direction}</span></td>
                    <td>{s.entry ?? "-"}</td>
                    <td>{s.sl ?? "-"}</td>
                    <td>{s.tp ?? "-"}</td>
                    <td>{s.confidence}%</td>
                    <td><span className={`badge ${s.status === "active" ? "badge-active" : ""}`}>{s.status}</span></td>
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
        Cron: GitHub Actions 1H → POST /api/cron/analyze • Evaluate +5min • Learning loop injects last 10 losses + weekly lesson into Gemini prompt.
      </div>
    </div>
  );
}
