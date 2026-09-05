export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export async function fetchKlines(
  symbol = "BTCUSDT",
  interval = "1h",
  limit = 200
): Promise<Kline[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
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
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance price error ${res.status}`);
  const data = (await res.json()) as { price: string };
  return parseFloat(data.price);
}
