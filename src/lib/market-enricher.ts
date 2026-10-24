import { InsiderTransaction } from '@/types/insider';

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface MarketDataSummary {
  currentPrice: number;
  recentPriceChange30dPct: number;
  pctFrom3moHigh: number;
  threeMonthHigh: number;
}

interface NewsHeadline {
  title: string;
  pubDate?: string;
}

/**
 * Renser HTML-entiteter fra RSS-overskrifter.
 */
function cleanHtmlEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[(.*?)\]\]>/gi, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * Henter historiske lukkekurser for en ticker via Yahoo Finance chart API.
 */
async function fetchMarketPrices(
  ticker: string,
  signal: AbortSignal
): Promise<MarketDataSummary | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker
  )}?range=3mo&interval=1d`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      Accept: 'application/json',
    },
    signal,
  });

  if (!res.ok) return null;

  const data = await res.json();
  const rawCloses = data.chart?.result?.[0]?.indicators?.quote?.[0]?.close;

  if (!Array.isArray(rawCloses)) return null;

  const closes: number[] = rawCloses.filter(
    (c: unknown): c is number => typeof c === 'number' && !isNaN(c) && c > 0
  );

  if (closes.length < 2) return null;

  const currentPrice = closes[closes.length - 1];
  const threeMonthHigh = Math.max(...closes);
  const pctFrom3moHigh = Number(
    (((currentPrice - threeMonthHigh) / threeMonthHigh) * 100).toFixed(1)
  );

  // 30 dages handelsdage svarer ca. til 21-22 handelsdage bagud
  const lookbackIndex = Math.max(0, closes.length - 22);
  const price30dAgo = closes[lookbackIndex];
  const recentPriceChange30dPct = Number(
    (((currentPrice - price30dAgo) / price30dAgo) * 100).toFixed(1)
  );

  return {
    currentPrice: Number(currentPrice.toFixed(2)),
    recentPriceChange30dPct,
    pctFrom3moHigh,
    threeMonthHigh: Number(threeMonthHigh.toFixed(2)),
  };
}

/**
 * Henter de nyeste overskrifter for tickeren via Yahoo Finance RSS eller Google News RSS.
 */
async function fetchNewsHeadlines(
  ticker: string,
  signal: AbortSignal
): Promise<NewsHeadline[]> {
  const headlines: NewsHeadline[] = [];

  // 1. Forsøg Yahoo Finance RSS
  try {
    const yahooUrl = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(
      ticker
    )}&region=US&lang=en-US`;
    const res = await fetch(yahooUrl, {
      headers: { 'User-Agent': BROWSER_USER_AGENT },
      signal,
    });

    if (res.ok) {
      const xml = await res.text();
      const itemMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];

      for (const match of itemMatches.slice(0, 4)) {
        const itemContent = match[1];
        const titleMatch = itemContent.match(/<title>(.*?)<\/title>/i);
        const dateMatch = itemContent.match(/<pubDate>(.*?)<\/pubDate>/i);

        if (titleMatch?.[1]) {
          const cleanedTitle = cleanHtmlEntities(titleMatch[1]);
          if (
            cleanedTitle &&
            !cleanedTitle.toLowerCase().includes('yahoo') &&
            !headlines.some((h) => h.title === cleanedTitle)
          ) {
            headlines.push({
              title: cleanedTitle,
              pubDate: dateMatch?.[1] ? dateMatch[1].split(' ').slice(1, 4).join(' ') : undefined,
            });
          }
        }
      }
    }
  } catch {
    // Fortsæt til fallback
  }

  // 2. Hvis ingen overskrifter fra Yahoo, prøv Google News RSS
  if (headlines.length < 2) {
    try {
      const gNewsUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(
        ticker
      )}+stock&hl=en-US&gl=US&ceid=US:en`;
      const res = await fetch(gNewsUrl, {
        headers: { 'User-Agent': BROWSER_USER_AGENT },
        signal,
      });

      if (res.ok) {
        const xml = await res.text();
        const itemMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];

        for (const match of itemMatches.slice(0, 4)) {
          const itemContent = match[1];
          const titleMatch = itemContent.match(/<title>(.*?)<\/title>/i);
          const dateMatch = itemContent.match(/<pubDate>(.*?)<\/pubDate>/i);

          if (titleMatch?.[1]) {
            const cleanedTitle = cleanHtmlEntities(titleMatch[1]);
            if (
              cleanedTitle &&
              cleanedTitle !== 'Google News' &&
              !headlines.some((h) => h.title === cleanedTitle)
            ) {
              headlines.push({
                title: cleanedTitle,
                pubDate: dateMatch?.[1] ? dateMatch[1].split(' ').slice(1, 4).join(' ') : undefined,
              });
            }
          }
        }
      }
    } catch {
      // Ignorer
    }
  }

  return headlines.slice(0, 4);
}

/**
 * Beriger en InsiderTransaction med live kursudvikling (30d + 3mo high) og nyhedsoverskrifter.
 * 3 sekunders timeout og fuld fejltolerance.
 */
export async function enrichTransactionWithMarketData(
  tx: InsiderTransaction
): Promise<InsiderTransaction> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);

  try {
    const [pricesResult, newsResult] = await Promise.allSettled([
      fetchMarketPrices(tx.ticker, controller.signal),
      fetchNewsHeadlines(tx.ticker, controller.signal),
    ]);

    const prices = pricesResult.status === 'fulfilled' ? pricesResult.value : null;
    const news = newsResult.status === 'fulfilled' ? newsResult.value : [];

    const notesParts: string[] = [];

    // Hvis vi fandt live kursdata
    if (prices) {
      tx.recentPriceChange30dPct = prices.recentPriceChange30dPct;
      notesParts.push(
        `Kurs-kontekst: Seneste lukkekurs $${prices.currentPrice} (${
          prices.recentPriceChange30dPct >= 0 ? '+' : ''
        }${prices.recentPriceChange30dPct}% seneste 30d, ${prices.pctFrom3moHigh}% fra 3-mdr top $${
          prices.threeMonthHigh
        }).`
      );
    }

    // Hvis vi fandt nyheder
    if (news && news.length > 0) {
      const formattedNews = news
        .map((n) => `• ${n.pubDate ? `[${n.pubDate}] ` : ''}${n.title}`)
        .join('\n');
      notesParts.push(`Seneste nyheder & katalysatorer:\n${formattedNews}`);
    }

    if (notesParts.length > 0) {
      const generatedNotes = notesParts.join('\n\n');
      tx.contextNotes = tx.contextNotes
        ? `${tx.contextNotes}\n\n${generatedNotes}`
        : generatedNotes;
    }

    return tx;
  } catch (error) {
    console.warn(`Fejl eller timeout ved markedsberigelse af ${tx.ticker}:`, error);
    return tx;
  } finally {
    clearTimeout(timeoutId);
  }
}
