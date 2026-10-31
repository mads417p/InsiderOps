import { CompanyFundamentals, FundamentalHealthBadge, InsiderTransaction } from '@/types/insider';
import { getCikForTicker } from '@/lib/sec-scanner';

interface XbrlFactItem {
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

interface XbrlConcept {
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
  if (amount === undefined || amount === null || isNaN(amount)) return '$0';
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

/**
 * Udtrækker samlede kontanter og kortfristede investeringer (Cash & Equivalents).
 */
function extractCashAndEquivalents(gaap: Record<string, XbrlConcept>): number {
  const cashCandidates = [
    'CashAndCashEquivalentsAtCarryingValue',
    'CashCashEquivalentsAndShortTermInvestments',
    'MarketableSecuritiesCurrent',
    'ShortTermInvestments',
    'Cash',
    'CashAndCashEquivalentsFairValueOfConsolidatedAndNonconsolidatedEntities',
  ];

  let latestEnd = '';
  for (const c of cashCandidates) {
    const item = extractLatestConceptItem(gaap, c);
    if (item && item.end > latestEnd) {
      latestEnd = item.end;
    }
  }

  if (!latestEnd) return 0;

  const cash =
    extractConceptItemByDate(gaap, 'CashAndCashEquivalentsAtCarryingValue', latestEnd)?.val ||
    extractConceptItemByDate(gaap, 'Cash', latestEnd)?.val ||
    0;

  const stInvest =
    extractConceptItemByDate(gaap, 'ShortTermInvestments', latestEnd)?.val ||
    extractConceptItemByDate(gaap, 'MarketableSecuritiesCurrent', latestEnd)?.val ||
    0;

  const combined =
    extractConceptItemByDate(gaap, 'CashCashEquivalentsAndShortTermInvestments', latestEnd)?.val || 0;

  return Math.max(combined, cash + stInvest);
}

/**
 * Udtrækker samlet kort- og langfristet gæld.
 */
function extractTotalDebt(gaap: Record<string, XbrlConcept>): number {
  const debtCandidates = [
    'LongTermDebt',
    'LongTermDebtNoncurrent',
    'LongTermDebtCurrent',
    'DebtCurrent',
    'ShortTermBorrowings',
    'NotesAndLoansPayable',
  ];

  let latestEnd = '';
  for (const c of debtCandidates) {
    const item = extractLatestConceptItem(gaap, c);
    if (item && item.end > latestEnd) {
      latestEnd = item.end;
    }
  }

  if (!latestEnd) return 0;

  const ltTotal = extractConceptItemByDate(gaap, 'LongTermDebt', latestEnd)?.val;
  const ltNonCurrent =
    extractConceptItemByDate(gaap, 'LongTermDebtNoncurrent', latestEnd)?.val || 0;
  const ltCurrent = extractConceptItemByDate(gaap, 'LongTermDebtCurrent', latestEnd)?.val || 0;
  const debtCurrent = extractConceptItemByDate(gaap, 'DebtCurrent', latestEnd)?.val || 0;
  const stBorrowings = extractConceptItemByDate(gaap, 'ShortTermBorrowings', latestEnd)?.val || 0;

  const currentDebt = Math.max(ltCurrent, debtCurrent, stBorrowings);
  if (ltTotal !== undefined) {
    return Math.max(ltTotal, ltNonCurrent + currentDebt);
  }
  return ltNonCurrent + currentDebt;
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
async function fetchSecXbrlFacts(cikStr: string, userAgent: string): Promise<XbrlCompanyFacts | null> {
  const paddedCik = String(cikStr).padStart(10, '0');
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${paddedCik}.json`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/json',
      },
      next: { revalidate: 3600 },
    });

    if (!res.ok) {
      return null;
    }

    return (await res.json()) as XbrlCompanyFacts;
  } catch (err) {
    console.warn(`Fejl ved hentning af SEC facts for CIK ${paddedCik}:`, err);
    return null;
  }
}

/**
 * Parser regnskabsdato fra Finviz ("Oct 22 BMO", "Aug 05 AMC", osv.)
 */
function parseFinvizEarnings(raw?: string | null): {
  nextEarningsDate?: string;
  daysUntilEarnings?: number;
} {
  if (!raw || raw.trim() === '-' || raw.trim() === '') {
    return {};
  }

  const cleaned = raw.replace(/\s*(BMO|AMC|\/r|\/a)\s*/gi, '').trim();
  const months: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };

  const now = new Date();
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

  const date = new Date(Date.UTC(targetYear, targetMonth, targetDay));
  const iso = date.toISOString().split('T')[0];
  const todayUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const diffDays = Math.round((date.getTime() - todayUtc.getTime()) / (1000 * 60 * 60 * 24));

  return {
    nextEarningsDate: iso,
    daysUntilEarnings: diffDays,
  };
}

/**
 * Henter nøgletal (Short Float, Short Ratio, P/E, P/B, Earnings Date) fra Finviz.
 */
async function fetchFinvizMetrics(ticker: string): Promise<{
  shortPercentOfFloat?: number;
  daysToCover?: number;
  peRatio?: number | null;
  priceToBook?: number | null;
  nextEarningsDate?: string;
  daysUntilEarnings?: number;
}> {
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

    if (!res.ok) return {};

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

    // 5. Earnings Date
    const earningsParsed = parseFinvizEarnings(kvMap['Earnings']);

    return {
      shortPercentOfFloat,
      daysToCover,
      peRatio,
      priceToBook,
      nextEarningsDate: earningsParsed.nextEarningsDate,
      daysUntilEarnings: earningsParsed.daysUntilEarnings,
    };
  } catch (err) {
    console.warn(`Fejl ved hentning af Finviz for ${cleanTicker}:`, err);
    return {};
  }
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

  const userAgent =
    process.env.SEC_USER_AGENT || 'InsiderOps/1.0 (mads.rosengaard2003@gmail.com)';

  let cashAndEquivalentsUsd: number | undefined;
  let totalDebtUsd: number | undefined;
  let netCashUsd: number | undefined;
  let quarterlyCashBurnUsd: number | undefined;
  let estimatedRunwayMonths: number | null | undefined;
  let isCashFlowPositive: boolean | undefined;

  let shortPercentOfFloat: number | undefined;
  let daysToCover: number | undefined;
  let nextEarningsDate: string | undefined;
  let daysUntilEarnings: number | undefined;
  let peRatio: number | null | undefined;
  let priceToBook: number | null | undefined;

  try {
    // 1. Parallel kørsel: CIK lookup + Finviz metrics
    const [cikInfo, finviz] = await Promise.all([
      getCikForTicker(cleanTicker, userAgent),
      fetchFinvizMetrics(cleanTicker),
    ]);

    if (finviz) {
      shortPercentOfFloat = finviz.shortPercentOfFloat;
      daysToCover = finviz.daysToCover;
      peRatio = finviz.peRatio;
      priceToBook = finviz.priceToBook;
      nextEarningsDate = finviz.nextEarningsDate;
      daysUntilEarnings = finviz.daysUntilEarnings;
    }

    // 2. Hvis CIK fundet, hent SEC EDGAR XBRL facts
    if (cikInfo && cikInfo.cik) {
      const facts = await fetchSecXbrlFacts(cikInfo.cik, userAgent);
      if (facts && facts.facts && facts.facts['us-gaap']) {
        const gaap = facts.facts['us-gaap'];

        cashAndEquivalentsUsd = extractCashAndEquivalents(gaap);
        totalDebtUsd = extractTotalDebt(gaap);
        netCashUsd = cashAndEquivalentsUsd - totalDebtUsd;

        const cf = extractOperatingCashFlow(gaap);
        if (cf) {
          isCashFlowPositive = cf.isPositive;
          if (cf.isPositive) {
            estimatedRunwayMonths = null;
            quarterlyCashBurnUsd = undefined;
          } else {
            const burn = Math.abs(cf.quarterlyRate);
            quarterlyCashBurnUsd = burn;
            if (burn > 0 && cashAndEquivalentsUsd > 0) {
              estimatedRunwayMonths =
                Math.round((cashAndEquivalentsUsd / burn) * 3 * 10) / 10;
            } else if (cashAndEquivalentsUsd <= 0) {
              estimatedRunwayMonths = 0;
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn(`Fejl under udtræk af fundamentals for ${cleanTicker}:`, err);
  }

  // 3. Klassificering (fundamentalHealthBadge)
  let fundamentalHealthBadge: FundamentalHealthBadge = 'NEUTRAL';

  if (estimatedRunwayMonths !== null && estimatedRunwayMonths !== undefined && estimatedRunwayMonths < 9) {
    // Akut risiko for aktieudvanding!
    fundamentalHealthBadge = 'DILUTION_RISK';
  } else if (
    (shortPercentOfFloat ?? 0) >= 12 &&
    (isCashFlowPositive || (estimatedRunwayMonths ?? 99) >= 15)
  ) {
    // Høj short-andel + stærk kassebeholdning + insiderkøb = klassisk short squeeze setup
    fundamentalHealthBadge = 'SHORT_SQUEEZE_SETUP';
  } else if (
    (netCashUsd ?? 0) > 0 &&
    (isCashFlowPositive || (estimatedRunwayMonths ?? 99) >= 24)
  ) {
    // Netto kontant formue og enten cash-flow positiv eller > 2 års runway
    fundamentalHealthBadge = 'FORTRESS_BALANCE';
  } else if (isCashFlowPositive || (estimatedRunwayMonths ?? 99) >= 12) {
    fundamentalHealthBadge = 'SOLID_RUNWAY';
  } else {
    fundamentalHealthBadge = 'NEUTRAL';
  }

  // 4. Generér 1-linjes skarp opsummering (fundamentalSummary)
  let fundamentalSummary = '';
  const cashStr = formatCompactUsd(cashAndEquivalentsUsd);
  const debtStr = formatCompactUsd(totalDebtUsd);
  const shortStr = shortPercentOfFloat !== undefined ? `${shortPercentOfFloat.toFixed(1)}%` : undefined;

  switch (fundamentalHealthBadge) {
    case 'DILUTION_RISK':
      fundamentalSummary = `⚠️ Cash: ${cashStr} • Burn: -${formatCompactUsd(
        quarterlyCashBurnUsd
      )}/kvt • Runway: ~${estimatedRunwayMonths} mdr. (Akut emissions-risiko!)`;
      break;

    case 'SHORT_SQUEEZE_SETUP':
      fundamentalSummary = `🔥 Squeeze-Setup! Short Float: ${shortStr || '>12%'} • Days to Cover: ${
        daysToCover ?? 'N/A'
      } • Cash: ${cashStr} • Ingen udvandingsrisiko`;
      break;

    case 'FORTRESS_BALANCE':
      fundamentalSummary = `💰 Fortress Cash: ${cashStr} • Gæld: ${debtStr} • Net Cash: +${formatCompactUsd(
        netCashUsd
      )} • Runway: ${
        isCashFlowPositive ? 'Cash-Flow Positiv' : `>${Math.round(estimatedRunwayMonths ?? 24)} mdr.`
      }${shortStr ? ` • Short Float: ${shortStr}` : ''}`;
      break;

    case 'SOLID_RUNWAY':
      fundamentalSummary = `📈 Cash-Flow Positiv • Cash: ${cashStr} • Gæld: ${debtStr}${
        shortStr ? ` • Short Float: ${shortStr}` : ''
      }`;
      break;

    default:
      fundamentalSummary = `⚖️ Cash: ${cashStr} • Gæld: ${debtStr}${
        estimatedRunwayMonths !== null && estimatedRunwayMonths !== undefined
          ? ` • Runway: ~${estimatedRunwayMonths} mdr.`
          : isCashFlowPositive
          ? ' • Cash-Flow Positiv'
          : ''
      }${shortStr ? ` • Short Float: ${shortStr}` : ''}`;
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
    nextEarningsDate,
    daysUntilEarnings,
    peRatio,
    priceToBook,
    fundamentalHealthBadge,
    fundamentalSummary,
  };

  fundamentalsCache.set(cleanTicker, { timestamp: Date.now(), data: result });
  return result;
}
