import { InsiderTransaction } from '@/types/insider';

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface MarketDataSummary {
  currentPrice: number;
  recentPriceChange30dPct: number;
  pctFrom3moHigh: number;
  threeMonthHigh: number;
  exchangeName?: string;
  fullExchangeName?: string;
  instrumentType?: string;
  currency?: string;
  avgDailyDollarVolume?: number;
  shortName?: string;
  longName?: string;
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
 * Henter historiske lukkekurser, metadata og volumen for en ticker via Yahoo Finance chart API.
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
  const res0 = data.chart?.result?.[0];
  const meta = res0?.meta;
  const rawCloses = res0?.indicators?.quote?.[0]?.close;
  const rawVolumes = res0?.indicators?.quote?.[0]?.volume;

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

  // Beregn 20-dages gennemsnitlig daglig handelsvolumen i USD/valuta (volume * close)
  let avgDailyDollarVolume = 0;
  if (Array.isArray(rawVolumes)) {
    const len = Math.min(rawCloses.length, rawVolumes.length);
    const startIdx = Math.max(0, len - 20);
    let sum = 0;
    let count = 0;
    for (let i = startIdx; i < len; i++) {
      const c = rawCloses[i];
      const v = rawVolumes[i];
      if (typeof c === 'number' && typeof v === 'number' && c > 0 && v > 0) {
        sum += c * v;
        count++;
      }
    }
    if (count > 0) {
      avgDailyDollarVolume = Math.round(sum / count);
    }
  }

  return {
    currentPrice: Number(currentPrice.toFixed(2)),
    recentPriceChange30dPct,
    pctFrom3moHigh,
    threeMonthHigh: Number(threeMonthHigh.toFixed(2)),
    exchangeName: meta?.exchangeName,
    fullExchangeName: meta?.fullExchangeName,
    instrumentType: meta?.instrumentType,
    currency: meta?.currency,
    avgDailyDollarVolume,
    shortName: meta?.shortName,
    longName: meta?.longName,
  };
}

/**
 * Verificerer om en aktie er handelbar for danske detailinvestorer via platforme som Nordnet og Saxo Bank.
 * Tjekker:
 * 1. Børs-whitelist: Kun NASDAQ, NYSE og Nasdaq Nordic (Copenhagen, Stockholm, Oslo). Afviser OTC / Pink Sheets.
 * 2. Instrument-type & EU PRIIPs/KID: Afviser lukkede amerikanske fonde (CEF), trusts og ETF'er, der mangler KID.
 * 3. Minimumskurs & Likviditet: Kurs >= $2.00 (eller >= 10 DKK) og gennemsnitlig daglig omsætning >= $500.000 USD.
 */
export function verifyDkTradability(
  tx: InsiderTransaction,
  meta?: {
    exchangeName?: string;
    fullExchangeName?: string;
    instrumentType?: string;
    currency?: string;
    currentPrice?: number;
    avgDailyDollarVolume?: number;
    shortName?: string;
    longName?: string;
  }
): {
  isTradableInDK: boolean;
  tradabilityReason: string;
  exchange: string;
  avgDailyDollarVolume: number;
} {
  const currentPrice = meta?.currentPrice || tx.currentMarketPrice || tx.pricePerShare || 0;
  const avgDailyDollarVolume = meta?.avgDailyDollarVolume || tx.avgDailyDollarVolume || 0;
  const exchangeRaw = (meta?.exchangeName || tx.exchange || '').toUpperCase();
  const fullExchange = (meta?.fullExchangeName || '').toUpperCase();
  const instrument = (meta?.instrumentType || 'EQUITY').toUpperCase();
  const currency = (meta?.currency || (tx.ticker.includes('.CO') ? 'DKK' : 'USD')).toUpperCase();
  const compName = (tx.companyName || '').toLowerCase();

  // 1. Børs-tjek (Godkendte hovedbørser vs. OTC / Pink Sheets)
  let exchangeFormatted = 'NASDAQ';
  if (
    exchangeRaw === 'NMS' ||
    exchangeRaw === 'NGM' ||
    exchangeRaw === 'NCM' ||
    fullExchange.includes('NASDAQ') ||
    exchangeRaw.includes('NASDAQ')
  ) {
    exchangeFormatted = 'NASDAQ';
  } else if (
    exchangeRaw === 'NYQ' ||
    exchangeRaw === 'ASE' ||
    fullExchange.includes('NYSE') ||
    exchangeRaw.includes('NYSE')
  ) {
    exchangeFormatted = 'NYSE';
  } else if (
    exchangeRaw === 'CPH' ||
    fullExchange.includes('COPENHAGEN') ||
    tx.ticker.includes('.CO')
  ) {
    exchangeFormatted = 'CPH (Nasdaq Copenhagen)';
  } else if (
    exchangeRaw === 'STO' ||
    exchangeRaw === 'OSL' ||
    exchangeRaw === 'HEX' ||
    fullExchange.includes('STOCKHOLM') ||
    fullExchange.includes('OSLO')
  ) {
    exchangeFormatted = 'Nasdaq Nordic';
  } else if (
    ['PNK', 'OTC', 'OBB', 'GREY', 'PINX'].includes(exchangeRaw) ||
    fullExchange.includes('OTC') ||
    fullExchange.includes('PINK')
  ) {
    return {
      isTradableInDK: false,
      tradabilityReason: 'AFVIST: US OTC / Pink Sheets (Ikke godkendt fondsbørs for danske detailinvestorer)',
      exchange: 'OTC',
      avgDailyDollarVolume,
    };
  } else {
    exchangeFormatted = exchangeRaw || 'US Main Market';
  }

  // 2. Instrument-tjek & EU PRIIPs / KID blokering (US Closed-End Funds & Trusts)
  if (instrument !== 'EQUITY') {
    return {
      isTradableInDK: false,
      tradabilityReason: `AFVIST: US Fond / ${instrument} (Blokeret i EU/DK pga. PRIIPs/KID reglerne)`,
      exchange: exchangeFormatted,
      avgDailyDollarVolume,
    };
  }

  const isClosedEndFundOrTrust =
    compName.includes('fund') ||
    compName.includes('trust') ||
    compName.includes('income shares') ||
    compName.includes('closed-end');

  if (isClosedEndFundOrTrust && currency === 'USD') {
    return {
      isTradableInDK: false,
      tradabilityReason: 'AFVIST: US Closed-End Fund / Trust (Blokeret i EU/DK pga. PRIIPs/KID reglerne)',
      exchange: exchangeFormatted,
      avgDailyDollarVolume,
    };
  }

  // 3. Minimumskurs & Likviditet
  const minPrice = currency === 'DKK' ? 10.0 : 2.0;
  if (currentPrice > 0 && currentPrice < minPrice) {
    const formattedPrice = currency === 'DKK' ? `${currentPrice} DKK` : `$${currentPrice}`;
    const formattedMin = currency === 'DKK' ? '10 DKK' : '$2.00';
    return {
      isTradableInDK: false,
      tradabilityReason: `AFVIST: Penny Stock (Kurs ${formattedPrice} er under minimumskravet på ${formattedMin})`,
      exchange: exchangeFormatted,
      avgDailyDollarVolume,
    };
  }

  if (avgDailyDollarVolume > 0 && avgDailyDollarVolume < 500000) {
    return {
      isTradableInDK: false,
      tradabilityReason: `AFVIST: Illikvid aktie (Gns. daglig omsætning $${Math.round(
        avgDailyDollarVolume
      ).toLocaleString()} er under $500.000/dag)`,
      exchange: exchangeFormatted,
      avgDailyDollarVolume,
    };
  }

  const volFormatted =
    avgDailyDollarVolume >= 1000000
      ? `$${(avgDailyDollarVolume / 1000000).toFixed(1)}M/dag`
      : avgDailyDollarVolume > 0
      ? `$${Math.round(avgDailyDollarVolume / 1000)}k/dag`
      : 'Ukendt';

  return {
    isTradableInDK: true,
    tradabilityReason: `Verificeret: ${exchangeFormatted} • Likviditet ${volFormatted} • Handelbar på Nordnet / Saxo`,
    exchange: exchangeFormatted,
    avgDailyDollarVolume,
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

    // 1. Tjek DK Handelbarhed & Likviditet (Nordnet / Saxo Gate)
    const tradability = verifyDkTradability(tx, {
      exchangeName: prices?.exchangeName,
      fullExchangeName: prices?.fullExchangeName,
      instrumentType: prices?.instrumentType,
      currency: prices?.currency,
      currentPrice: prices?.currentPrice,
      avgDailyDollarVolume: prices?.avgDailyDollarVolume,
      shortName: prices?.shortName,
      longName: prices?.longName,
    });

    tx.exchange = tradability.exchange;
    tx.isTradableInDK = tradability.isTradableInDK;
    tx.tradabilityReason = tradability.tradabilityReason;
    tx.avgDailyDollarVolume = tradability.avgDailyDollarVolume;

    if (!tradability.isTradableInDK) {
      notesParts.push(`⚠️ HANDELBARHED ADVARSEL (DK): ${tradability.tradabilityReason}`);
    } else {
      notesParts.push(`DK Mægler-Status: ${tradability.tradabilityReason}`);
    }

    // Hvis vi fandt live kursdata
    if (prices) {
      tx.recentPriceChange30dPct = prices.recentPriceChange30dPct;
      tx.currentMarketPrice = prices.currentPrice;

      if (tx.pricePerShare > 0 && tx.transactionCode === 'P') {
        const diffPct = Number(
          (((prices.currentPrice - tx.pricePerShare) / tx.pricePerShare) * 100).toFixed(2)
        );
        tx.returnSinceBuyPct = diffPct;
        tx.isTradingBelowInsiderPrice = prices.currentPrice < tx.pricePerShare;

        const discountText = tx.isTradingBelowInsiderPrice
          ? `(RABAT: Handler ${Math.abs(diffPct)}% under insiderens købspris!)`
          : `(Insider afkast siden køb: +${diffPct}%)`;

        notesParts.push(
          `Insider Alpha: Købskurs $${tx.pricePerShare} vs. Aktuel kurs $${prices.currentPrice} ${discountText}`
        );
      }

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
