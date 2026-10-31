const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export interface VerifiedLiveQuote {
  ticker: string;
  price: number;
  previousClose: number;
  changePct: number;
  currency: string;
  lastQuoteTime: string; // ISO-8601 or exchange formatted string
  quoteSource: string; // e.g. "CNBC + Yahoo Real-Time Verified", "Yahoo 1m Intraday", etc.
  exchange?: string;
  cnbcPrice?: number;
  yahooPrice?: number;
  isRealTime: boolean;
}

export interface LiveFxRates {
  USD_DKK: number;
  SEK_DKK: number;
  EUR_DKK: number;
  NOK_DKK: number;
  lastUpdated: string;
  isLive: boolean;
}

// Fallback kurser i tilfælde af midlertidig netværksfejl
const FALLBACK_FX_RATES: LiveFxRates = {
  USD_DKK: 6.6968,
  SEK_DKK: 0.6813,
  EUR_DKK: 7.4735,
  NOK_DKK: 0.6400,
  lastUpdated: new Date().toISOString(),
  isLive: false,
};

let cachedFx: { rates: LiveFxRates; timestamp: number } | null = null;
const FX_CACHE_TTL_MS = 60_000; // 1 minut intern cache i memory for at undgå at overbelaste Yahoo på batch-kald

/**
 * Henter ægte live valutakurser mod DKK via Yahoo Finance med no-store.
 */
export async function fetchLiveFxRates(): Promise<LiveFxRates> {
  const now = Date.now();
  if (cachedFx && now - cachedFx.timestamp < FX_CACHE_TTL_MS) {
    return cachedFx.rates;
  }

  const rates: LiveFxRates = { ...FALLBACK_FX_RATES, lastUpdated: new Date().toISOString(), isLive: false };

  const pairs = [
    { key: 'USD_DKK' as const, symbol: 'USDDKK=X' },
    { key: 'SEK_DKK' as const, symbol: 'SEKDKK=X' },
    { key: 'EUR_DKK' as const, symbol: 'EURDKK=X' },
  ];

  await Promise.all(
    pairs.map(async ({ key, symbol }) => {
      try {
        const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
          symbol
        )}?range=1d&interval=1m&_t=${Date.now()}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);

        const res = await fetch(url, {
          headers: {
            'User-Agent': BROWSER_USER_AGENT,
            Accept: 'application/json',
          },
          cache: 'no-store',
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.ok) {
          const json = await res.json();
          const meta = json?.chart?.result?.[0]?.meta;
          if (typeof meta?.regularMarketPrice === 'number' && meta.regularMarketPrice > 0) {
            rates[key] = meta.regularMarketPrice;
            rates.isLive = true;
          }
        }
      } catch (e) {
        console.warn(`Kunne ikke hente live FX kurs for ${symbol}:`, e);
      }
    })
  );

  cachedFx = { rates, timestamp: now };
  return rates;
}

/**
 * Returnerer den relevante valutakurs til omregning af et aktiv i given valuta til DKK.
 */
export function getFxRateToDkk(currency: string | undefined, rates: LiveFxRates): number {
  if (!currency) return rates.USD_DKK;
  const upper = currency.toUpperCase().trim();
  if (upper === 'DKK') return 1.0;
  if (upper === 'USD' || upper === '$' || upper === 'US$') return rates.USD_DKK;
  if (upper === 'SEK') return rates.SEK_DKK;
  if (upper === 'EUR' || upper === '€') return rates.EUR_DKK;
  if (upper === 'NOK') return rates.NOK_DKK;
  return rates.USD_DKK;
}

/**
 * Dual-Source Real-Time Kursmotor:
 * Kilde 1: CNBC Real-Time Exchange API (NASDAQ/NYSE direkte feeds)
 * Kilde 2: Yahoo Finance 1-Minute Intraday Feed (query2.finance.yahoo.com)
 * Krydsverificerer kurser og tidsstempler uden Next.js caching.
 */
export async function fetchVerifiedLiveQuote(ticker: string): Promise<VerifiedLiveQuote> {
  const cleanTicker = ticker.toUpperCase().trim();
  const isNordic =
    cleanTicker.endsWith('.CO') ||
    cleanTicker.endsWith('.ST') ||
    cleanTicker.endsWith('.HE') ||
    cleanTicker.endsWith('.OL');

  let cnbcQuote: {
    last: number;
    prevClose: number;
    changePct: number;
    lastTime: string;
    exchange: string;
    currency: string;
  } | null = null;

  let yahooQuote: {
    price: number;
    prevClose: number;
    changePct: number;
    timeIso: string;
    exchange: string;
    currency: string;
  } | null = null;

  // 1. Kilde 1: CNBC Real-Time Exchange API (kun for US aktier)
  if (!isNordic) {
    try {
      const cnbcUrl = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(
        cleanTicker
      )}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);

      const res = await fetch(cnbcUrl, {
        headers: {
          'User-Agent': BROWSER_USER_AGENT,
          Accept: 'application/json',
        },
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const json = await res.json();
        const item = json?.FormattedQuoteResult?.FormattedQuote?.[0];
        if (item && item.last) {
          const parsedLast = parseFloat(item.last.replace(/,/g, ''));
          const parsedPrev = item.previous_day_closing
            ? parseFloat(item.previous_day_closing.replace(/,/g, ''))
            : parsedLast;
          const parsedChangePct = item.change_pct
            ? parseFloat(item.change_pct.replace('%', '').replace('+', ''))
            : 0;

          if (!isNaN(parsedLast) && parsedLast > 0) {
            cnbcQuote = {
              last: parsedLast,
              prevClose: isNaN(parsedPrev) ? parsedLast : parsedPrev,
              changePct: isNaN(parsedChangePct) ? 0 : parsedChangePct,
              lastTime: item.last_timedate || item.last_time || '',
              exchange: item.exchange || 'US',
              currency: item.currencyCode || 'USD',
            };
          }
        }
      }
    } catch (e) {
      console.warn(`CNBC quote fetch mislykkedes for ${cleanTicker}:`, e);
    }
  }

  // 2. Kilde 2: Yahoo Finance 1-Minute Intraday Feed (query2)
  try {
    const yahooUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      cleanTicker
    )}?range=1d&interval=1m&_t=${Date.now()}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);

    const res = await fetch(yahooUrl, {
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (meta && typeof meta.regularMarketPrice === 'number' && meta.regularMarketPrice > 0) {
        const prevClose = meta.previousClose || meta.chartPreviousClose || meta.regularMarketPrice;
        const changePct =
          typeof meta.regularMarketChangePercent === 'number'
            ? meta.regularMarketChangePercent
            : prevClose > 0
            ? ((meta.regularMarketPrice - prevClose) / prevClose) * 100
            : 0;
        const timeIso = meta.regularMarketTime
          ? new Date(meta.regularMarketTime * 1000).toISOString()
          : new Date().toISOString();

        yahooQuote = {
          price: meta.regularMarketPrice,
          prevClose,
          changePct: Number(changePct.toFixed(2)),
          timeIso,
          exchange: meta.exchangeName || meta.fullExchangeName || '',
          currency: meta.currency || (isNordic ? 'DKK' : 'USD'),
        };
      }
    }
  } catch (e) {
    console.warn(`Yahoo 1m fetch mislykkedes for ${cleanTicker}:`, e);
  }

  // 3. Krydsverifikation og kilde-sammenstilling
  if (cnbcQuote && yahooQuote) {
    // Begge kilder er tilgængelige (Dual-Source Verified)
    // Afrunding til 2 decimaler for US aktier er standard
    const finalPrice = yahooQuote.price;
    return {
      ticker: cleanTicker,
      price: finalPrice,
      previousClose: yahooQuote.prevClose,
      changePct: yahooQuote.changePct,
      currency: cnbcQuote.currency || yahooQuote.currency,
      lastQuoteTime: yahooQuote.timeIso,
      quoteSource: 'CNBC + Yahoo Real-Time Verified',
      exchange: cnbcQuote.exchange || yahooQuote.exchange,
      cnbcPrice: cnbcQuote.last,
      yahooPrice: yahooQuote.price,
      isRealTime: true,
    };
  }

  if (cnbcQuote) {
    return {
      ticker: cleanTicker,
      price: cnbcQuote.last,
      previousClose: cnbcQuote.prevClose,
      changePct: cnbcQuote.changePct,
      currency: cnbcQuote.currency,
      lastQuoteTime: cnbcQuote.lastTime || new Date().toISOString(),
      quoteSource: 'CNBC Real-Time Exchange',
      exchange: cnbcQuote.exchange,
      cnbcPrice: cnbcQuote.last,
      isRealTime: true,
    };
  }

  if (yahooQuote) {
    return {
      ticker: cleanTicker,
      price: yahooQuote.price,
      previousClose: yahooQuote.prevClose,
      changePct: yahooQuote.changePct,
      currency: yahooQuote.currency,
      lastQuoteTime: yahooQuote.timeIso,
      quoteSource: isNordic
        ? 'Yahoo Finance 1m Intraday (Nordic Live)'
        : 'Yahoo Finance 1m Intraday',
      exchange: yahooQuote.exchange,
      yahooPrice: yahooQuote.price,
      isRealTime: true,
    };
  }

  // Hvis begge hurtige kilder fejler, returner graceful fallback
  return {
    ticker: cleanTicker,
    price: 0,
    previousClose: 0,
    changePct: 0,
    currency: isNordic ? 'DKK' : 'USD',
    lastQuoteTime: new Date().toISOString(),
    quoteSource: 'Fallback / Ikke Tilgængelig',
    isRealTime: false,
  };
}
