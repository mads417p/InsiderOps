import { CompanyFundamentals, FundamentalHealthBadge, InsiderTransaction } from '@/types/insider';
import { getCikForTicker } from '@/lib/sec-scanner';
import { secFetch } from '@/lib/sec-client';

export interface XbrlFactItem {
  end: string;
  val: number;
  accn?: string;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  frame?: string;
  start?: string;
}

export interface XbrlConcept {
  label?: string;
  description?: string;
  units?: Record<string, XbrlFactItem[]>;
}

interface XbrlCompanyFacts {
  cik?: number;
  entityName?: string;
  facts?: {
    'us-gaap'?: Record<string, XbrlConcept>;
    dei?: Record<string, XbrlConcept>;
    'ifrs-full'?: Record<string, XbrlConcept>;
  };
}

// In-memory cache for company fundamentals (1 time TTL)
interface CacheEntry {
  timestamp: number;
  data: CompanyFundamentals;
}
const fundamentalsCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 time

/**
 * Formatér et dollarbeløb kompakt (f.eks. $312M, $1.4B eller $750k).
 */
export function formatCompactUsd(amount?: number | null): string {
  if (amount === undefined || amount === null || isNaN(amount)) return 'mangler data';
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (abs >= 1_000_000_000) {
    return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  }
  if (abs >= 1_000_000) {
    return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 1_000) {
    return `${sign}$${Math.round(abs / 1_000)}k`;
  }
  return `${sign}$${Math.round(abs)}`;
}

/**
 * Hjælper til at udtrække nyeste 10-Q/10-K værdi fra et US-GAAP XBRL koncept.
 */
function extractLatestConceptItem(
  gaap: Record<string, XbrlConcept>,
  conceptName: string
): XbrlFactItem | null {
  const concept = gaap[conceptName];
  if (!concept || !concept.units) return null;
  const unitKey = Object.keys(concept.units)[0];
  const items = concept.units[unitKey];
  if (!Array.isArray(items)) return null;

  const filtered = items.filter(
    (i) => (i.form === '10-Q' || i.form === '10-K') && i.end && i.val !== undefined
  );
  if (filtered.length === 0) return null;
  filtered.sort((a, b) => b.end.localeCompare(a.end) || (b.filed || '').localeCompare(a.filed || ''));
  return filtered[0];
}

/**
 * Hjælper til at udtrække værdi for en specifik balancedato 'end'.
 */
function extractConceptItemByDate(
  gaap: Record<string, XbrlConcept>,
  conceptName: string,
  targetEnd: string
): XbrlFactItem | null {
  const concept = gaap[conceptName];
  if (!concept || !concept.units) return null;
  const unitKey = Object.keys(concept.units)[0];
  const items = concept.units[unitKey];
  if (!Array.isArray(items)) return null;

  const filtered = items.filter(
    (i) => (i.form === '10-Q' || i.form === '10-K') && i.end === targetEnd && i.val !== undefined
  );
  if (filtered.length === 0) return null;
  filtered.sort((a, b) => (b.filed || '').localeCompare(a.filed || ''));
  return filtered[0];
}

/** Nyeste balancedato på tværs af tags ('' hvis ingen af dem har 10-Q/10-K-facts). */
function latestEndOf(gaap: Record<string, XbrlConcept>, tags: string[]): string {
  return tags.reduce((latest, t) => {
    const end = extractLatestConceptItem(gaap, t)?.end ?? '';
    return end > latest ? end : latest;
  }, '');
}

const valueAt = (gaap: Record<string, XbrlConcept>, tag: string, end: string) =>
  extractConceptItemByDate(gaap, tag, end)?.val;

/** Værdierne af de tags, der faktisk har en fact på datoen (manglende tags udelades – de er IKKE 0). */
const valuesAt = (gaap: Record<string, XbrlConcept>, tags: string[], end: string) =>
  tags.map((t) => valueAt(gaap, t, end)).filter((v): v is number => v !== undefined);

const CASH_TAGS = [
  'CashAndCashEquivalentsAtCarryingValue',
  'Cash',
  'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
];
const SHORT_TERM_INVESTMENT_TAGS = ['ShortTermInvestments', 'MarketableSecuritiesCurrent'];
const CASH_AND_ST_COMBINED = 'CashCashEquivalentsAndShortTermInvestments';

/**
 * Kontanter + kortfristede investeringer. undefined, hvis selskabet ikke rapporterer cash i XBRL (ukendt ≠ 0).
 */
export function extractCashAndEquivalents(gaap: Record<string, XbrlConcept>): number | undefined {
  const latestEnd = latestEndOf(gaap, [...CASH_TAGS, CASH_AND_ST_COMBINED]);
  if (!latestEnd) return undefined;

  const cash = valuesAt(gaap, CASH_TAGS, latestEnd)[0];
  const stInvest = valuesAt(gaap, SHORT_TERM_INVESTMENT_TAGS, latestEnd)[0];
  const combined = valueAt(gaap, CASH_AND_ST_COMBINED, latestEnd);
  if (cash === undefined && combined === undefined) return undefined;

  return Math.max(combined ?? 0, (cash ?? 0) + (stInvest ?? 0));
}

const LONG_TERM_TOTAL_TAG = 'LongTermDebt'; // inkl. kortfristet del
// Langfristet del ekskl. kortfristet. ACN bruger kun LongTermDebtAndCapitalLeaseObligations.
const LONG_TERM_NONCURRENT_TAGS = [
  'LongTermDebtNoncurrent',
  'LongTermDebtAndCapitalLeaseObligations',
  'LongTermNotesPayable',
];
const CURRENT_DEBT_TAGS = ['LongTermDebtCurrent', 'DebtCurrent', 'ShortTermBorrowings'];
const ADDITIONAL_DEBT_TAGS = ['ConvertibleNotesPayable', 'NotesAndLoansPayable'];

/**
 * Samlet kort- og langfristet gæld. undefined, hvis ingen gælds-tags findes (ukendt ≠ gældfri).
 */
export function extractTotalDebt(gaap: Record<string, XbrlConcept>): number | undefined {
  const latestEnd = latestEndOf(gaap, [
    LONG_TERM_TOTAL_TAG,
    ...LONG_TERM_NONCURRENT_TAGS,
    ...CURRENT_DEBT_TAGS,
    ...ADDITIONAL_DEBT_TAGS,
  ]);
  if (!latestEnd) return undefined;

  const ltTotal = valueAt(gaap, LONG_TERM_TOTAL_TAG, latestEnd) ?? 0;
  const nonCurrent = valuesAt(gaap, LONG_TERM_NONCURRENT_TAGS, latestEnd)[0] ?? 0;
  const current = Math.max(0, ...valuesAt(gaap, CURRENT_DEBT_TAGS, latestEnd));
  // ponytail: konvertible lån og NotesAndLoansPayable lægges oveni. Kan dobbelttælle, hvis et selskab også
  // har dem med i LongTermDebt – fjern dem fra summen pr. selskab, hvis det viser sig i praksis.
  const additional = valuesAt(gaap, ADDITIONAL_DEBT_TAGS, latestEnd).reduce((a, b) => a + b, 0);

  return Math.max(ltTotal, nonCurrent + current) + additional;
}

/**
 * Udtrækker Operating Cash Flow og omregner til kvartalsvis rate.
 */
function extractOperatingCashFlow(
  gaap: Record<string, XbrlConcept>
): {
  quarterlyRate: number;
  isPositive: boolean;
  rawVal: number;
  periodMonths: number;
  end: string;
} | null {
  const concept = gaap['NetCashProvidedByUsedInOperatingActivities'];
  if (!concept || !concept.units) return null;
  const unitKey = Object.keys(concept.units)[0];
  const items = concept.units[unitKey];
  if (!Array.isArray(items)) return null;

  const filtered = items.filter(
    (i) => (i.form === '10-Q' || i.form === '10-K') && i.start && i.end && i.val !== undefined
  );
  if (filtered.length === 0) return null;
  filtered.sort((a, b) => b.end.localeCompare(a.end) || (b.filed || '').localeCompare(a.filed || ''));

  const latest = filtered[0];
  const startDate = new Date(latest.start!);
  const endDate = new Date(latest.end);
  const diffDays = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
  const periodMonths = Math.max(1, Math.round(diffDays / 30.4));

  // Normalisér til 3 måneders (kvartalsvis) rate
  const quarterlyRate = Math.round((latest.val / periodMonths) * 3);

  return {
    quarterlyRate,
    isPositive: quarterlyRate >= 0,
    rawVal: latest.val,
    periodMonths,
    end: latest.end,
  };
}

/**
 * Henter SEC EDGAR CompanyFacts JSON for et CIK-nummer.
 */
async function fetchSecXbrlFacts(cikStr: string): Promise<XbrlCompanyFacts | null> {
  const paddedCik = String(cikStr).padStart(10, '0');
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${paddedCik}.json`;

  try {
    // no-store: companyfacts kan være 6 MB (ACN) – for stort til Next' fetch-cache. Resultatet caches i fundamentalsCache.
    const res = await secFetch(url, { accept: 'application/json', timeoutMs: 20_000 });

    if (!res.ok) {
      return null;
    }

    return (await res.json()) as XbrlCompanyFacts;
  } catch (err) {
    console.warn(`Fejl ved hentning af SEC facts for CIK ${paddedCik}:`, err);
    return null;
  }
}

interface EarningsDate {
  nextEarningsDate?: string;
  daysUntilEarnings?: number;
  nextEarningsDateEstimated?: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Kun fremtidige (eller dagens) datoer er en "næste" regnskabsdato. En dato i fortiden betyder ukendt. */
function futureDateOnly(year: number, month: number, day: number, now: Date): EarningsDate {
  const date = new Date(Date.UTC(year, month, day));
  const todayUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const diffDays = Math.round((date.getTime() - todayUtc.getTime()) / (1000 * 60 * 60 * 24));
  if (isNaN(diffDays) || diffDays < 0) return {};
  return { nextEarningsDate: date.toISOString().split('T')[0], daysUntilEarnings: diffDays };
}

/**
 * Parser Nasdaqs earnings-date-svar: announcement "Earnings announcement* for ACN: Dec 17, 2026".
 * reportText "is estimated to report" = Zacks-estimat, ikke bekræftet af selskabet.
 */
export function parseNasdaqEarnings(
  data: { announcement?: string | null; reportText?: string | null } | null | undefined,
  now: Date = new Date()
): EarningsDate {
  const m = /:\s*([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})/.exec(data?.announcement ?? '');
  const month = m ? MONTHS[m[1].toLowerCase()] : undefined;
  if (!m || month === undefined) return {};
  const parsed = futureDateOnly(parseInt(m[3], 10), month, parseInt(m[2], 10), now);
  if (parsed.nextEarningsDate && /estimated to report/i.test(data?.reportText ?? '')) {
    parsed.nextEarningsDateEstimated = true;
  }
  return parsed;
}

/** Næste regnskabsdato fra Nasdaq (kun US-tickers). null = opslaget fejlede. */
async function fetchNasdaqNextEarnings(ticker: string): Promise<EarningsDate | null> {
  try {
    const res = await fetch(`https://api.nasdaq.com/api/analyst/${encodeURIComponent(ticker)}/earnings-date`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(6000),
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { announcement?: string; reportText?: string } | null };
    return parseNasdaqEarnings(json.data);
  } catch (err) {
    console.warn(`Fejl ved hentning af næste regnskabsdato fra Nasdaq for ${ticker}:`, err);
    return null;
  }
}

/**
 * Parser regnskabsdato fra Finviz ("Oct 22 BMO", "Aug 05 AMC", osv.).
 * Finviz viser den seneste dato, indtil den næste er kendt – en dato i fortiden kasseres derfor.
 */
export function parseFinvizEarnings(raw?: string | null, now: Date = new Date()): EarningsDate {
  if (!raw || raw.trim() === '-' || raw.trim() === '') {
    return {};
  }

  const cleaned = raw.replace(/\s*(BMO|AMC|\/r|\/a)\s*/gi, '').trim();
  const months = MONTHS;

  let targetYear = now.getFullYear();
  let targetMonth = now.getMonth();
  let targetDay = now.getDate();

  const mMatch = cleaned.match(/^([a-z]{3})\s+(\d{1,2})(?:[,\s]+(\d{4}))?$/i);
  if (mMatch) {
    const monStr = mMatch[1].toLowerCase();
    targetMonth = months[monStr] ?? now.getMonth();
    targetDay = parseInt(mMatch[2], 10);
    if (mMatch[3]) {
      targetYear = parseInt(mMatch[3], 10);
    } else {
      // Hvis måneden ligger mere end 6 måneder tilbage i år, er det formentlig næste års rapportering
      const currentMonth = now.getMonth();
      if (targetMonth < currentMonth - 6) {
        targetYear = now.getFullYear() + 1;
      } else {
        targetYear = now.getFullYear();
      }
    }
  } else {
    const parsed = new Date(cleaned);
    if (!isNaN(parsed.getTime())) {
      targetYear = parsed.getFullYear();
      targetMonth = parsed.getMonth();
      targetDay = parsed.getDate();
    } else {
      return {};
    }
  }

  return futureDateOnly(targetYear, targetMonth, targetDay, now);
}

/**
 * Henter nøgletal (Short Float, Short Ratio, P/E, P/B, Earnings Date) fra Finviz. null = opslaget fejlede.
 */
async function fetchFinvizMetrics(ticker: string): Promise<{
  shortPercentOfFloat?: number;
  daysToCover?: number;
  peRatio?: number | null;
  priceToBook?: number | null;
  earnings: EarningsDate;
} | null> {
  const cleanTicker = ticker.trim().toUpperCase();
  const url = `https://finviz.com/quote.ashx?t=${encodeURIComponent(cleanTicker)}`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      next: { revalidate: 1800 },
    });

    if (!res.ok) return null;

    const html = await res.text();
    const pairRegex =
      /snapshot-td-label[^>]*>([\s\S]*?)<\/div>[\s\S]*?snapshot-td-content[^>]*>([\s\S]*?)<\/div>/gi;

    let m;
    const kvMap: Record<string, string> = {};
    while ((m = pairRegex.exec(html)) !== null) {
      const label = m[1].replace(/<[^>]+>/g, '').trim();
      const val = m[2].replace(/<[^>]+>/g, '').trim();
      if (label) {
        kvMap[label] = val;
      }
    }

    // 1. Short Float
    let shortPercentOfFloat: number | undefined;
    if (kvMap['Short Float'] && kvMap['Short Float'] !== '-') {
      const parsed = parseFloat(kvMap['Short Float'].replace('%', ''));
      if (!isNaN(parsed)) shortPercentOfFloat = parsed;
    }

    // 2. Short Ratio (Days to Cover)
    let daysToCover: number | undefined;
    if (kvMap['Short Ratio'] && kvMap['Short Ratio'] !== '-') {
      const parsed = parseFloat(kvMap['Short Ratio']);
      if (!isNaN(parsed)) daysToCover = parsed;
    }

    // 3. P/E
    let peRatio: number | null | undefined;
    if (kvMap['P/E']) {
      if (kvMap['P/E'] === '-') {
        peRatio = null;
      } else {
        const parsed = parseFloat(kvMap['P/E']);
        peRatio = isNaN(parsed) ? null : parsed;
      }
    }

    // 4. P/B
    let priceToBook: number | null | undefined;
    if (kvMap['P/B']) {
      if (kvMap['P/B'] === '-') {
        priceToBook = null;
      } else {
        const parsed = parseFloat(kvMap['P/B']);
        priceToBook = isNaN(parsed) ? null : parsed;
      }
    }

    // 5. Earnings Date (kun fremtidige datoer)
    return {
      shortPercentOfFloat,
      daysToCover,
      peRatio,
      priceToBook,
      earnings: parseFinvizEarnings(kvMap['Earnings']),
    };
  } catch (err) {
    console.warn(`Fejl ved hentning af Finviz for ${cleanTicker}:`, err);
    return null;
  }
}

const NORDIC_SUFFIX = /.(CO|ST|HE|OL)$/i;

/**
 * Sundhedsbadge ud fra kendte tal. Ukendt cash flow eller ukendt runway giver UNKNOWN – aldrig et positivt badge.
 */
export function deriveHealthBadge(f: {
  estimatedRunwayMonths?: number | null;
  isCashFlowPositive?: boolean;
  netCashUsd?: number;
  shortPercentOfFloat?: number;
}): FundamentalHealthBadge {
  const runway = f.estimatedRunwayMonths;
  if (typeof runway === 'number' && runway < 9) return 'DILUTION_RISK';
  if (f.isCashFlowPositive === undefined) return 'UNKNOWN';
  if (f.isCashFlowPositive === false && typeof runway !== 'number') return 'UNKNOWN'; // brænder penge, cash ukendt

  const runwayAtLeast = (months: number) =>
    f.isCashFlowPositive === true || (typeof runway === 'number' && runway >= months);
  if ((f.shortPercentOfFloat ?? 0) >= 12 && runwayAtLeast(15)) return 'SHORT_SQUEEZE_SETUP';
  if (f.netCashUsd !== undefined && f.netCashUsd > 0 && runwayAtLeast(24)) return 'FORTRESS_BALANCE';
  if (runwayAtLeast(12)) return 'SOLID_RUNWAY';
  return 'NEUTRAL';
}

/**
 * Hovedfunktion: Henter selskabets fundamentale balance, cash runway, short interest & regnskabsdato.
 */
export async function fetchCompanyFundamentals(
  tx: InsiderTransaction
): Promise<CompanyFundamentals> {
  const cleanTicker = tx.ticker.trim().toUpperCase();

  // Tjek in-memory cache
  const cached = fundamentalsCache.get(cleanTicker);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  let cashAndEquivalentsUsd: number | undefined;
  let totalDebtUsd: number | undefined;
  let quarterlyCashBurnUsd: number | undefined;
  let estimatedRunwayMonths: number | null | undefined;
  let isCashFlowPositive: boolean | undefined;

  let shortPercentOfFloat: number | undefined;
  let daysToCover: number | undefined;
  let earnings: EarningsDate = {};
  let peRatio: number | null | undefined;
  let priceToBook: number | null | undefined;
  // Fejlede opslag caches ikke, så næste kald prøver igen.
  let lookupFailed = false;

  try {
    // 1. Parallel kørsel: CIK lookup + Finviz metrics
    const [cikInfo, finviz] = await Promise.all([
      getCikForTicker(cleanTicker),
      fetchFinvizMetrics(cleanTicker),
    ]);

    if (finviz) {
      shortPercentOfFloat = finviz.shortPercentOfFloat;
      daysToCover = finviz.daysToCover;
      peRatio = finviz.peRatio;
      priceToBook = finviz.priceToBook;
      earnings = finviz.earnings;
    } else {
      lookupFailed = true;
    }

    // Finviz viser den seneste dato, til den næste er kendt. Mangler en fremtidig dato, spørges Nasdaq (kun US).
    if (!earnings.nextEarningsDate && !NORDIC_SUFFIX.test(cleanTicker)) {
      const nasdaq = await fetchNasdaqNextEarnings(cleanTicker);
      if (nasdaq) earnings = nasdaq;
      else lookupFailed = true;
    }

    // 2. Hvis CIK fundet, hent SEC EDGAR XBRL facts
    if (cikInfo && cikInfo.cik) {
      const facts = await fetchSecXbrlFacts(cikInfo.cik);
      if (!facts) lookupFailed = true;
      if (facts && facts.facts && facts.facts['us-gaap']) {
        const gaap = facts.facts['us-gaap'];

        cashAndEquivalentsUsd = extractCashAndEquivalents(gaap);
        totalDebtUsd = extractTotalDebt(gaap);

        const cf = extractOperatingCashFlow(gaap);
        if (cf) {
          isCashFlowPositive = cf.isPositive;
          if (cf.isPositive) {
            estimatedRunwayMonths = null; // null = selvfinansierende, undefined = ukendt
          } else {
            const burn = Math.abs(cf.quarterlyRate);
            quarterlyCashBurnUsd = burn;
            if (cashAndEquivalentsUsd !== undefined) {
              estimatedRunwayMonths =
                cashAndEquivalentsUsd > 0 ? Math.round((cashAndEquivalentsUsd / burn) * 3 * 10) / 10 : 0;
            }
          }
        }
      }
    }
  } catch (err) {
    lookupFailed = true;
    console.warn(`Fejl under udtræk af fundamentals for ${cleanTicker}:`, err);
  }

  const netCashUsd =
    cashAndEquivalentsUsd !== undefined && totalDebtUsd !== undefined
      ? cashAndEquivalentsUsd - totalDebtUsd
      : undefined;

  // 3. Klassificering (fundamentalHealthBadge) – ukendt data giver UNKNOWN, aldrig et positivt badge
  const fundamentalHealthBadge = deriveHealthBadge({
    estimatedRunwayMonths,
    isCashFlowPositive,
    netCashUsd,
    shortPercentOfFloat,
  });

  // 4. Generér 1-linjes skarp opsummering (fundamentalSummary)
  let fundamentalSummary = '';
  const cashStr = formatCompactUsd(cashAndEquivalentsUsd);
  const debtStr = formatCompactUsd(totalDebtUsd);
  const shortStr = shortPercentOfFloat !== undefined ? `${shortPercentOfFloat.toFixed(1)}%` : undefined;
  const runwayStr = isCashFlowPositive ? 'Cash-Flow Positiv' : `Runway: ~${estimatedRunwayMonths} mdr.`;

  switch (fundamentalHealthBadge) {
    case 'DILUTION_RISK':
      fundamentalSummary = `⚠️ Cash: ${cashStr} • Burn: -${formatCompactUsd(
        quarterlyCashBurnUsd
      )}/kvt • Runway: ~${estimatedRunwayMonths} mdr. (Akut emissions-risiko!)`;
      break;

    case 'SHORT_SQUEEZE_SETUP':
      fundamentalSummary = `🔥 Squeeze-Setup! Short Float: ${shortStr} • Days to Cover: ${
        daysToCover ?? 'mangler data'
      } • Cash: ${cashStr} • ${runwayStr}`;
      break;

    case 'FORTRESS_BALANCE':
      fundamentalSummary = `💰 Fortress Cash: ${cashStr} • Gæld: ${debtStr} • Net Cash: +${formatCompactUsd(
        netCashUsd
      )} • ${runwayStr}${shortStr ? ` • Short Float: ${shortStr}` : ''}`;
      break;

    case 'SOLID_RUNWAY':
      fundamentalSummary = `📈 ${runwayStr} • Cash: ${cashStr} • Gæld: ${debtStr}${
        shortStr ? ` • Short Float: ${shortStr}` : ''
      }`;
      break;

    case 'UNKNOWN':
      fundamentalSummary = `❔ Mangler data: ${
        isCashFlowPositive === undefined ? 'cash flow ukendt (ingen SEC XBRL-data)' : 'cash ukendt, runway kan ikke beregnes'
      } • Cash: ${cashStr} • Gæld: ${debtStr}${shortStr ? ` • Short Float: ${shortStr}` : ''}`;
      break;

    default:
      fundamentalSummary = `⚖️ Cash: ${cashStr} • Gæld: ${debtStr} • ${runwayStr}${
        shortStr ? ` • Short Float: ${shortStr}` : ''
      }`;
      break;
  }

  const result: CompanyFundamentals = {
    cashAndEquivalentsUsd,
    totalDebtUsd,
    netCashUsd,
    quarterlyCashBurnUsd,
    estimatedRunwayMonths,
    isCashFlowPositive,
    shortPercentOfFloat,
    daysToCover,
    ...earnings,
    peRatio,
    priceToBook,
    fundamentalHealthBadge,
    fundamentalSummary,
  };

  if (!lookupFailed) {
    fundamentalsCache.set(cleanTicker, { timestamp: Date.now(), data: result });
  }
  return result;
}
