import { InsiderTransaction } from '@/types/insider';
import { convertCurrency, currencyForTicker, fetchLiveFxRates, type LiveFxRates } from '@/lib/live-quote';

// Alt efter denne linje i contextNotes er genereret markedsdata og erstattes ved næste berigelse.
export const MARKET_NOTES_MARKER = '[Markedsdata – opdateres ved hver berigelse]';

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface MarketDataSummary {
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
  atr14d?: number;
  dailyVolatilityPct?: number;
  supportLow30d?: number;
  resistanceHigh90d?: number;
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
export async function fetchMarketPrices(
  ticker: string,
  signal?: AbortSignal
): Promise<MarketDataSummary | null> {
  const controller = !signal ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 8000) : null;
  const effectiveSignal = signal || controller!.signal;

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      ticker
    )}?range=3mo&interval=1d`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'application/json',
      },
      signal: effectiveSignal,
    });

    if (!res.ok) return null;

  const data = await res.json();
  const res0 = data.chart?.result?.[0];
  const meta = res0?.meta;
  const rawHighs = res0?.indicators?.quote?.[0]?.high;
  const rawLows = res0?.indicators?.quote?.[0]?.low;
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

  // Beregn 14-dages ATR (Average True Range), normal daglig volatilitet samt support/resistance
  let atr14d: number | undefined;
  let dailyVolatilityPct: number | undefined;
  let supportLow30d: number | undefined;
  let resistanceHigh90d: number | undefined;

  if (Array.isArray(rawHighs) && Array.isArray(rawLows) && Array.isArray(rawCloses)) {
    const trs: number[] = [];
    for (let i = 1; i < rawCloses.length; i++) {
      const h = rawHighs[i];
      const l = rawLows[i];
      const prevC = rawCloses[i - 1];
      if (
        typeof h === 'number' &&
        typeof l === 'number' &&
        typeof prevC === 'number' &&
        h > 0 &&
        l > 0 &&
        prevC > 0
      ) {
        const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
        trs.push(tr);
      }
    }

    if (trs.length >= 5) {
      const last14 = trs.slice(-14);
      const avgAtr = last14.reduce((sum, val) => sum + val, 0) / last14.length;
      atr14d = Number(avgAtr.toFixed(2));
      dailyVolatilityPct = Number(((atr14d / currentPrice) * 100).toFixed(2));
    }

    const validLows = rawLows.filter((l: unknown): l is number => typeof l === 'number' && l > 0);
    const validHighs = rawHighs.filter((h: unknown): h is number => typeof h === 'number' && h > 0);

    if (validLows.length > 0) {
      const recentLows = validLows.slice(-22);
      supportLow30d = Number(Math.min(...recentLows).toFixed(2));
    }
    if (validHighs.length > 0) {
      resistanceHigh90d = Number(Math.max(...validHighs).toFixed(2));
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
    atr14d,
    dailyVolatilityPct,
    supportLow30d,
    resistanceHigh90d,
  };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

const NORDIC_VENUES: Record<string, string> = {
  CO: 'CPH (Nasdaq Copenhagen)',
  ST: 'STO (Nasdaq Stockholm)',
  HE: 'HEL (Nasdaq Helsinki)',
  OL: 'OSL (Oslo Børs)',
};
const NORDIC_CURRENCY: Record<string, string> = { CO: 'DKK', ST: 'SEK', HE: 'EUR', OL: 'NOK' };

/**
 * Verificerer om en aktie er handelbar for danske detailinvestorer via Nordnet og Saxo Bank.
 * 1. Børs: eksplicit liste – NASDAQ, NYSE, NYSE American, Cboe (fra Yahoo-metadata) og .CO/.ST/.HE/.OL. Alt andet afvises.
 * 2. Instrument og EU PRIIPs/KID: kun EQUITY; US closed-end funds/trusts afvises.
 * 3. Minimumskurs og likviditet: kurs >= $2 (10 DKK), gns. daglig omsætning >= 500.000.
 * Kendte afvisninger giver false. Mangler børs, instrumenttype, kurs eller volumen, er resultatet undefined
 * ("Ikke verificeret – data mangler") – aldrig "Verificeret" uden data.
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
  },
  fx?: LiveFxRates | null
): {
  isTradableInDK?: boolean;
  tradabilityReason: string;
  exchange?: string;
  avgDailyDollarVolume?: number;
} {
  const nordic = /.(CO|ST|HE|OL)$/i.exec(tx.ticker.trim())?.[1]?.toUpperCase();
  const currency = (meta?.currency || (nordic ? NORDIC_CURRENCY[nordic] : 'USD')).toUpperCase();
  // Kurs og omsætning omregnes til USD med live FX, før $2- og $500k-grænserne anvendes
  // (et DKK-papir skulle før kun omsætte ca. $72k/dag). Markedskurs – aldrig insiderens købskurs som stand-in.
  const toUsd = (v?: number) => (v === undefined || v <= 0 ? undefined : convertCurrency(v, currency, 'USD', fx));
  const localPrice = meta?.currentPrice || tx.currentMarketPrice || undefined;
  const currentPrice = toUsd(localPrice);
  // tx.avgDailyDollarVolume er allerede i USD (fra en tidligere berigelse); meta-volumen er i lokal valuta.
  const avgDailyDollarVolume = meta?.avgDailyDollarVolume ? toUsd(meta.avgDailyDollarVolume) : tx.avgDailyDollarVolume || undefined;
  const fxMissing = convertCurrency(1, currency, 'USD', fx) === undefined;
  const exchangeRaw = (meta?.exchangeName || '').toUpperCase();
  const fullExchange = (meta?.fullExchangeName || '').toUpperCase();
  const instrument = meta?.instrumentType?.toUpperCase();
  const compName = (tx.companyName || '').toLowerCase();

  // 1. Børs: eksplicit allowlist
  let exchange: string | undefined;
  if (nordic) {
    exchange = NORDIC_VENUES[nordic];
  } else if (
    ['PNK', 'OTC', 'OBB', 'GREY', 'PINX', 'OQB', 'OQX'].includes(exchangeRaw) ||
    fullExchange.includes('OTC') ||
    fullExchange.includes('PINK')
  ) {
    return {
      isTradableInDK: false,
      tradabilityReason: 'AFVIST: US OTC / Pink Sheets (Ikke godkendt fondsbørs for danske detailinvestorer)',
      exchange: 'OTC',
      avgDailyDollarVolume,
    };
  } else if (['NMS', 'NGM', 'NCM', 'NAS'].includes(exchangeRaw) || fullExchange.includes('NASDAQ')) {
    exchange = 'NASDAQ';
  } else if (exchangeRaw === 'ASE' || fullExchange.includes('NYSE AMERICAN') || fullExchange.includes('NYSE MKT')) {
    exchange = 'NYSE American';
  } else if (exchangeRaw === 'NYQ' || fullExchange === 'NYSE') {
    exchange = 'NYSE';
  } else if (['BTS', 'BATS', 'CBOE'].includes(exchangeRaw) || fullExchange.includes('CBOE') || fullExchange.includes('BATS')) {
    exchange = 'Cboe';
  } else if (exchangeRaw || fullExchange) {
    return {
      isTradableInDK: false,
      tradabilityReason: `AFVIST: Børsen "${meta?.fullExchangeName || meta?.exchangeName}" er ikke på listen over godkendte børser`,
      exchange: meta?.fullExchangeName || meta?.exchangeName,
      avgDailyDollarVolume,
    };
  }

  // 2. Instrument-tjek & EU PRIIPs / KID blokering (US Closed-End Funds & Trusts)
  if (instrument && instrument !== 'EQUITY') {
    return {
      isTradableInDK: false,
      tradabilityReason: `AFVIST: US Fond / ${instrument} (Blokeret i EU/DK pga. PRIIPs/KID reglerne)`,
      exchange,
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
      exchange,
      avgDailyDollarVolume,
    };
  }

  // 3. Minimumskurs & Likviditet i USD (kun når tallene og valutakursen er kendt)
  if (currentPrice !== undefined && currentPrice < 2.0) {
    const formattedPrice = currency === 'USD' ? `$${localPrice}` : `${localPrice} ${currency} ≈ $${currentPrice.toFixed(2)}`;
    return {
      isTradableInDK: false,
      tradabilityReason: `AFVIST: Penny Stock (Kurs ${formattedPrice} er under minimumskravet på $2.00)`,
      exchange,
      avgDailyDollarVolume,
    };
  }

  if (avgDailyDollarVolume !== undefined && avgDailyDollarVolume < 500000) {
    return {
      isTradableInDK: false,
      tradabilityReason: `AFVIST: Illikvid aktie (Gns. daglig omsætning $${Math.round(
        avgDailyDollarVolume
      ).toLocaleString()} er under $500.000/dag)`,
      exchange,
      avgDailyDollarVolume,
    };
  }

  if (fxMissing) {
    return {
      isTradableInDK: undefined,
      tradabilityReason: `Ikke verificeret – valutakurs ${currency}/USD mangler`,
      exchange,
      avgDailyDollarVolume,
    };
  }

  const missing = [
    !exchange && 'børs',
    !instrument && 'instrumenttype',
    currentPrice === undefined && 'kurs',
    avgDailyDollarVolume === undefined && 'volumen',
  ].filter(Boolean);
  if (missing.length > 0) {
    return {
      isTradableInDK: undefined,
      tradabilityReason: `Ikke verificeret – data mangler (${missing.join(', ')})`,
      exchange,
      avgDailyDollarVolume,
    };
  }

  const vol = avgDailyDollarVolume as number;
  const volFormatted = vol >= 1000000 ? `$${(vol / 1000000).toFixed(1)}M/dag` : `$${Math.round(vol / 1000)}k/dag`;

  return {
    isTradableInDK: true,
    tradabilityReason: `Verificeret: ${exchange} • Likviditet ${volFormatted} • Handelbar på Nordnet / Saxo`,
    exchange,
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
    const [pricesResult, newsResult, fxResult] = await Promise.allSettled([
      fetchMarketPrices(tx.ticker, controller.signal),
      fetchNewsHeadlines(tx.ticker, controller.signal),
      fetchLiveFxRates(), // cachet 60 s – kun nødvendig for ikke-USD-aktier
    ]);

    const prices = pricesResult.status === 'fulfilled' ? pricesResult.value : null;
    const news = newsResult.status === 'fulfilled' ? newsResult.value : [];
    const fx = fxResult.status === 'fulfilled' ? fxResult.value : null;

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
    }, fx);

    tx.exchange = tradability.exchange ?? tx.exchange;
    tx.isTradableInDK = tradability.isTradableInDK;
    tx.tradabilityReason = tradability.tradabilityReason;
    tx.avgDailyDollarVolume = tradability.avgDailyDollarVolume;

    if (tradability.isTradableInDK === false) {
      notesParts.push(`⚠️ HANDELBARHED ADVARSEL (DK): ${tradability.tradabilityReason}`);
    } else {
      notesParts.push(`DK Mægler-Status: ${tradability.tradabilityReason}`);
    }

    // Hvis vi fandt live kursdata
    if (prices) {
      tx.recentPriceChange30dPct = prices.recentPriceChange30dPct;
      tx.currentMarketPrice = prices.currentPrice;
      tx.atr14d = prices.atr14d;
      tx.dailyVolatilityPct = prices.dailyVolatilityPct;
      tx.supportLow30d = prices.supportLow30d;
      tx.resistanceHigh90d = prices.resistanceHigh90d;

      // Insiderkurs og markedskurs sammenlignes kun i samme valuta (385 DKK mod $55,80 gav før "+590 %").
      const txCurrency = (tx.currency || 'USD').toUpperCase();
      const quoteCurrency = (prices.currency || currencyForTicker(tx.ticker)).toUpperCase();
      const label = quoteCurrency === 'USD' ? '$' : `${quoteCurrency} `;
      if (tx.pricePerShare > 0 && tx.transactionCode === 'P' && txCurrency === quoteCurrency) {
        const diffPct = Number(
          (((prices.currentPrice - tx.pricePerShare) / tx.pricePerShare) * 100).toFixed(2)
        );
        tx.returnSinceBuyPct = diffPct;
        tx.isTradingBelowInsiderPrice = prices.currentPrice < tx.pricePerShare;

        const discountText = tx.isTradingBelowInsiderPrice
          ? `(RABAT: Handler ${Math.abs(diffPct)}% under insiderens købspris!)`
          : `(Insider afkast siden køb: +${diffPct}%)`;

        notesParts.push(
          `Insider Alpha: Købskurs ${label}${tx.pricePerShare} vs. Aktuel kurs ${label}${prices.currentPrice} ${discountText}`
        );
      } else if (tx.transactionCode === 'P' && txCurrency !== quoteCurrency) {
        tx.returnSinceBuyPct = undefined;
        tx.isTradingBelowInsiderPrice = undefined;
        notesParts.push(`Insider Alpha: ikke beregnet – insiderkurs i ${txCurrency}, markedskurs i ${quoteCurrency}.`);
      }

      notesParts.push(
        `Kurs-kontekst: Seneste lukkekurs ${label}${prices.currentPrice} (${
          prices.recentPriceChange30dPct >= 0 ? '+' : ''
        }${prices.recentPriceChange30dPct}% seneste 30d, ${prices.pctFrom3moHigh}% fra 3-mdr top ${label}${
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
      // Markedsdata-blokken erstattes ved hver berigelse, så gamle kurser ikke hober sig op i prompten.
      const base = (tx.contextNotes || '').split(MARKET_NOTES_MARKER)[0].trimEnd();
      const generatedNotes = `${MARKET_NOTES_MARKER}\n${notesParts.join('\n\n')}`;
      tx.contextNotes = base ? `${base}\n\n${generatedNotes}` : generatedNotes;
    }

    return tx;
  } catch (error) {
    console.warn(`Fejl eller timeout ved markedsberigelse af ${tx.ticker}:`, error);
    return tx;
  } finally {
    clearTimeout(timeoutId);
  }
}
