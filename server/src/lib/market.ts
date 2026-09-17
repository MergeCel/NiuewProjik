// Market sentiment helpers (free, no API key needed, works on Vercel serverless)

export interface FearGreed {
  value: number;
  classification: string;
}

export interface NewsItem {
  title: string;
  source: string;
}

export async function fetchFearGreed(): Promise<FearGreed | null> {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1");
    const json = await res.json();
    const d = json?.data?.[0];
    if (!d) return null;
    return { value: Number(d.value), classification: d.value_classification };
  } catch (e) {
    console.warn("fetchFearGreed failed", e);
    return null;
  }
}

export async function fetchCryptoNews(limit = 5): Promise<NewsItem[]> {
  try {
    const url =
      "https://news.google.com/rss/search?q=crypto+bitcoin+altcoins+market&hl=en-US&gl=US&ceid=US:en";
    const res = await fetch(url);
    const xml = await res.text();
    const items = xml.split("<item>").slice(1);
    const news: NewsItem[] = [];
    for (const it of items) {
      const titleMatch = it.match(/<title>(.*?)<\/title>/);
      const sourceMatch = it.match(/<source[^>]*>(.*?)<\/source>/);
      if (!titleMatch) continue;
      const title = titleMatch[1]
        .replace(/<!\[CDATA\[|\]\]>/g, "")
        .replace(/&amp;/g, "&")
        .trim();
      news.push({
        title,
        source: sourceMatch?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim() ?? "",
      });
      if (news.length >= limit) break;
    }
    return news;
  } catch (e) {
    console.warn("fetchCryptoNews failed", e);
    return [];
  }
}