export const SUPPORTED_PAIRS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "DOTUSDT",
] as const;

export type SupportedPair = (typeof SUPPORTED_PAIRS)[number];

export function isSupportedPair(symbol: string): boolean {
  return (SUPPORTED_PAIRS as readonly string[]).includes(symbol);
}

export function formatPair(symbol: string): string {
  // BTCUSDT -> BTC/USDT
  const idx = symbol.toUpperCase().indexOf("USDT");
  if (idx > 0) return `${symbol.toUpperCase().slice(0, idx)}/USDT`;
  return symbol.toUpperCase();
}
