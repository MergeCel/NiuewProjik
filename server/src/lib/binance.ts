export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

function binanceHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  // Opsional untuk mitigasi >1 bulan / rate limit Vercel share IP
  // Isi BINANCE_API_KEY di env jika punya, tidak wajib untuk POC public
  if (process.env.BINANCE_API_KEY) h["X-MBX-APIKEY"] = process.env.BINANCE_API_KEY;
  return h;
}

export async function fetchKlines(
  symbol = "BTCUSDT",
  interval = "1h",
  limit = 200
): Promise<Kline[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { headers: binanceHeaders() });
  if (!res.ok) {
    throw new Error(`Binance error ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as any[][];
  return data.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
  }));
}

export async function fetchCurrentPrice(symbol = "BTCUSDT"): Promise<number> {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
  const res = await fetch(url, { headers: binanceHeaders() });
  if (!res.ok) throw new Error(`Binance price error ${res.status}`);
  const data = (await res.json()) as { price: string };
  return parseFloat(data.price);
}
