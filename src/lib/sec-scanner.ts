import { InsiderTransaction, TransactionCode } from '@/types/insider';
import { enrichTransactionWithMarketData } from '@/lib/market-enricher';
import { assertSecUrl, secFetch } from '@/lib/sec-client';

/**
 * Trin 2: Hård filtrering uden API-omkostninger.
 * Afviser handler, der ikke er åbne markedskøb (kode 'P') eller under $50.000 USD.
 */
export function applyHardFilter(tx: InsiderTransaction): { passed: boolean; reason?: string } {
  if (tx.transactionCode !== 'P') {
    const codeName =
      tx.transactionCode === 'M'
        ? "Option Exercise / RSU Vesting ('M')"
        : tx.transactionCode === 'S'
        ? "Almindeligt Salg ('S')"
        : tx.transactionCode === 'F'
        ? "Skatte-salg / Withholding ('F')"
        : tx.transactionCode === 'A'
        ? "Tildeling / Grant ('A')"
        : `Transaktionskode '${tx.transactionCode}'`;

    return {
      passed: false,
      reason: `Afvist: ${codeName}. Kun ægte åbne markedskøb (kode 'P' med egne midler) analyseres.`,
    };
  }

  if (tx.totalValueUsd < 50000) {
    return {
      passed: false,
      reason: `Afvist: Samlet værdi ($${Math.round(tx.totalValueUsd).toLocaleString()}) er under minimumsgrænsen på $50.000 for asymmetrisk signal.`,
    };
  }

  // 3. Tjek DK Handelbarhed & Likviditet (afvis illikvide penny stocks, US OTC og US closed-end fonde / PRIIPs)
  if (tx.isTradableInDK === false) {
    return {
      passed: false,
      reason:
        tx.tradabilityReason ||
        'Afvist: Ikke handelbar i Danmark (PRIIPs/KID blokering, OTC eller penny stock).',
    };
  }

  return { passed: true };
}

// Ordgrænser med Unicode-lookarounds: titler må aldrig matches på delstreng ("director" indeholder "cto",
// "representative" indeholder "pres"). Engelsk "director" er bestyrelse; dansk/svensk "direktør/direktör" er direktion.
const EXECUTIVE_TITLE_RE =
  /(?<![\p{L}\p{N}])(ceo|cfo|coo|cto|cmo|cso|cio|clo|cao|cco|chief|president|pres|evp|svp|vp|vice[ -]president|executive chair(?:man|woman)?|general counsel|counsel|treasurer|controller|secretary|officer|vd|koncernchef|direkt[øö]r|finansdirekt[øö]r|ekonomidirekt[öø]r|finanschef)(?![\p{L}\p{N}])/iu;

/**
 * Bestemmer om en titel tilhører direktionen / C-Suite (Officer).
 * Rene bestyrelsesposter ('Director', 'Chairman', 'Bestyrelsesmedlem', 'Styrelseledamot') og '10% Owner' er ikke executives.
 */
export function isExecutiveTitle(title?: string): boolean {
  if (!title) return false;
  return EXECUTIVE_TITLE_RE.test(title);
}

// Ord, der kun kan være en titel, rolle eller fyld – aldrig et navn. Et "navn" af lutter sådanne ord afvises.
const TITLE_ONLY_WORDS = new Set([
  // engelsk
  'chief', 'executive', 'financial', 'operating', 'technology', 'technical', 'legal', 'accounting', 'commercial',
  'officer', 'officers', 'ceo', 'cfo', 'coo', 'cto', 'cro', 'cio', 'cmo', 'cso', 'clo', 'cao', 'cco',
  'president', 'pres', 'vice', 'vp', 'evp', 'svp', 'director', 'directors', 'dir', 'board', 'member', 'members',
  'chairman', 'chairwoman', 'chair', 'chairperson', 'owner', 'ten', 'percent', '10%', 'insider', 'closely',
  'associated', 'person', 'persons', 'related', 'party', 'parties', 'general', 'counsel', 'secretary', 'treasurer',
  'controller', 'of', 'the', 'and', 'former', 'interim', 'acting', 'senior', 'see', 'remarks',
  'unknown', 'n', 'a', 'none', 'null', 'undefined',
  // dansk
  'bestyrelsesmedlem', 'bestyrelsesformand', 'næstformand', 'bestyrelse', 'direktør', 'direktion', 'adm', 'administrerende',
  'ledende', 'medarbejder', 'medarbejdere', 'nærtstående', 'nærstående', 'finansdirektør', 'koncernchef',
  // svensk / finsk
  'styrelseledamot', 'ledamot', 'styrelseordförande', 'ordförande', 'verkställande', 'direktör', 'vd', 'närstående',
  'hallituksen', 'jäsen', 'puheenjohtaja', 'toimitusjohtaja',
]);

/**
 * Validerer at et insider-navn er et reelt person- eller fondsnavn og ikke blot en stillingsbetegnelse
 * ('Dir', 'Chief Executive Officer', 'Chairman', 'Bestyrelsesmedlem', 'Verkställande direktör', 'Closely associated person').
 */
export function isValidInsiderName(name?: string | null): boolean {
  if (!name) return false;
  const clean = name.replace(/<[^>]+>/g, '').trim();
  if (clean.length < 3) return false;
  const words = clean.toLowerCase().split(/[^\p{L}\p{N}%]+/u).filter(Boolean);
  if (words.length === 0) return false;
  return !words.every((w) => TITLE_ONLY_WORDS.has(w) || w.length <= 1);
}

/**
 * Bestemmer om ejerskabet er direkte ('D') eller indirekte ('I' via fond/trust/holding).
 */
export function detectOwnershipNature(
  rawNature?: string,
  insiderName?: string,
  rawHtml?: string
): 'D' | 'I' {
  if (rawNature === 'D' || rawNature === 'I') return rawNature;

  if (rawHtml) {
    if (rawHtml.toLowerCase().includes('direct shares')) return 'D';
    if (rawHtml.toLowerCase().includes('indirect shares')) return 'I';
  }

  if (insiderName) {
    const n = insiderName.toLowerCase();
    if (
      n.includes(' llc') ||
      n.includes(' lp') ||
      n.includes(' l.p.') ||
      n.includes(' fund') ||
      n.includes(' trust') ||
      n.includes(' capital') ||
      n.includes(' partners') ||
      n.includes(' holdings') ||
      n.includes(' investments') ||
      n.includes(' group') ||
      n.includes(' management') ||
      n.includes(' corp') ||
      n.includes(' inc') ||
      n.includes(' bank')
    ) {
      return 'I';
    }
  }

  return 'D';
}

/** Normaliseret fuldt navn til sammenligning: NFKC, små bogstaver, æøå bevares, ingen afkortning. */
export function normalizeName(name?: string | null): string {
  return (name || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export const CLUSTER_WINDOW_DAYS = 10;
const DAY_MS = 86_400_000;

function dayIndex(date?: string): number | undefined {
  const t = Date.parse((date || '').slice(0, 10));
  return Number.isNaN(t) ? undefined : Math.round(t / DAY_MS);
}

/** Udtrækker det 18-cifrede accession-nummer fra en SEC-URL (…/edgar/data/<cik>/<accession>/…). */
export function accessionFromUrl(url?: string): string | undefined {
  const folder = url?.match(/\/edgar\/data\/\d+\/(\d{18})(?:\/|$)/i)?.[1];
  if (folder) return folder;
  const dashed = url?.match(/(\d{10})-(\d{2})-(\d{6})/);
  return dashed ? dashed.slice(1).join('') : undefined;
}

/** Fletter to rækker for samme handel fra to kilder: behold a, udfyld felter a mangler fra b. */
function mergeSameTrade(a: InsiderTransaction, b: InsiderTransaction): InsiderTransaction {
  const merged: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) if (merged[k] === undefined && v !== undefined) merged[k] = v;
  const m = merged as unknown as InsiderTransaction;
  m.isExecutiveOfficer = Boolean(a.isExecutiveOfficer || b.isExecutiveOfficer);
  if (a.is10b51Plan === true || b.is10b51Plan === true) m.is10b51Plan = true;
  return m;
}

/**
 * Samme handel set fra flere kilder (OpenInsider + EDGAR) bliver til én række.
 * Nøgle: accession-nummer + reporting owner CIK; uden dem ticker + fuldt navn + handelsdato + antal + kurs.
 * To personer med samme dato og antal aktier er derfor to købere.
 */
export function dedupTrades(rows: InsiderTransaction[]): InsiderTransaction[] {
  const byKey = new Map<string, InsiderTransaction>();
  for (const tx of rows) {
    const key =
      tx.accessionNo && tx.ownerCik
        ? `acc:${tx.accessionNo}:${tx.ownerCik}`
        : `raw:${tx.ticker.toUpperCase().trim()}:${normalizeName(tx.insiderName)}:${tx.tradeDate}:${tx.shares}:${tx.pricePerShare}`;
    const prev = byKey.get(key);
    byKey.set(key, prev ? mergeSameTrade(prev, tx) : { ...tx });
  }
  return [...byKey.values()];
}

/** Lead-rækken: største køb fra en executive, ellers største køb (ved lige beløb den nyeste handelsdato). */
export function pickLead(group: InsiderTransaction[]): InsiderTransaction {
  const pool = group.some((t) => t.isExecutiveOfficer) ? group.filter((t) => t.isExecutiveOfficer) : group;
  return [...pool].sort(
    (a, b) => (b.totalValueUsd || 0) - (a.totalValueUsd || 0) || (b.tradeDate || '').localeCompare(a.tradeDate || '')
  )[0];
}

/**
 * Køber-identitet pr. række: reporting owner CIK, ellers normaliseret fuldt navn.
 * Rækker i samme accession (fx en fond og dens managing member i samme ejerkæde) er én køber.
 */
function buyerKeys(rows: InsiderTransaction[]): Map<InsiderTransaction, string> {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    if (!parent.has(k)) parent.set(k, k);
    while (parent.get(k) !== k) k = parent.get(k)!;
    return k;
  };
  const person = (t: InsiderTransaction) => (t.ownerCik ? `cik:${t.ownerCik}` : `navn:${normalizeName(t.insiderName)}`);
  for (const t of rows) if (t.accessionNo) parent.set(find(person(t)), find(`acc:${t.accessionNo}`));
  return new Map(rows.map((t) => [t, find(person(t))]));
}

const priceLabel = (tx: InsiderTransaction) => (tx.currency && tx.currency !== 'USD' ? `${tx.currency} ` : '$');

/**
 * Cluster roll-up: præcis én række pr. ticker for alle kilder.
 * Forudsætning: rækkerne er kode P, har bestået hard-filteret og har en handelsdato (se buildScanRows).
 * Cluster = mindst to distinkte købere med handelsdato inden for ±10 kalenderdage af lead-rækkens.
 */
export function rollUpByTicker(rows: InsiderTransaction[]): InsiderTransaction[] {
  const byTicker = new Map<string, InsiderTransaction[]>();
  for (const tx of rows) {
    const key = tx.ticker.toUpperCase().trim();
    byTicker.set(key, [...(byTicker.get(key) ?? []), tx]);
  }

  const out: InsiderTransaction[] = [];
  for (const group of byTicker.values()) {
    // Lead vælges i det nyeste vindue: et ticker-scan dækker måneder, og et gammelt større køb må ikke
    // fortrænge den aktuelle runde (DINO: køb fra august blev lead frem for købet i oktober).
    const newest = Math.max(...group.map((t) => dayIndex(t.tradeDate) ?? -Infinity));
    const leadSrc = pickLead(group.filter((t) => (dayIndex(t.tradeDate) ?? -Infinity) >= newest - CLUSTER_WINDOW_DAYS));
    const lead: InsiderTransaction = { ...leadSrc };
    const leadDay = dayIndex(lead.tradeDate);
    // ponytail: vinduet centreres om lead-rækken; en klynge > 10 dage fra lead tælles ikke med.
    const inWindow = group.filter((t) => {
      const d = dayIndex(t.tradeDate);
      return leadDay !== undefined && d !== undefined && Math.abs(d - leadDay) <= CLUSTER_WINDOW_DAYS;
    });
    const keys = buyerKeys(inWindow);
    const leadBuyer = keys.get(leadSrc);
    const buyers = new Set(keys.values());

    // Samlet beløb: én værdi pr. distinkt handel, så en fælles indberetning ikke tælles to gange.
    const perTrade = new Map<string, number>();
    for (const t of inWindow) {
      const k = t.accessionNo ? `acc:${t.accessionNo}` : `id:${t.id}`;
      perTrade.set(k, Math.max(perTrade.get(k) ?? 0, t.totalValueUsd || 0));
    }
    const totalClusterUsd = [...perTrade.values()].reduce((a, b) => a + b, 0);

    lead.clusterCount = Math.max(1, buyers.size);
    lead.isClusterBuy = buyers.size >= 2;
    lead.clusterPeers = inWindow
      .filter((t) => keys.get(t) !== leadBuyer)
      .map(
        (t) =>
          `${t.insiderName} (${t.insiderTitle}): $${Math.round(t.totalValueUsd).toLocaleString('en-US')} (${t.shares.toLocaleString('en-US')} aktier á ${priceLabel(t)}${t.pricePerShare}) den ${t.tradeDate}`
      );

    const bestName = group.find((t) => t.companyName && t.companyName !== t.ticker)?.companyName;
    if (bestName && (!lead.companyName || lead.companyName === lead.ticker)) lead.companyName = bestName;

    if (lead.isClusterBuy) {
      const note = `BEKRÆFTET CLUSTER-KØB (${buyers.size} distinkte købere inden for ${CLUSTER_WINDOW_DAYS} dage, samlet værdi $${Math.round(
        totalClusterUsd
      ).toLocaleString('en-US')}). Med-købere: ${lead.clusterPeers.map((p) => p.split(':')[0]).join(', ')}.`;
      lead.contextNotes = lead.contextNotes ? `${note}\n\n${lead.contextNotes}` : note;
    }
    out.push(lead);
  }
  return out;
}

export interface RejectedRow {
  id: string;
  ticker: string;
  insiderName: string;
  reason: string;
}

/**
 * Fælles scan-pipeline for alle kilder:
 * kode P og ≥ $50k → handelsdato og navn → dedup → berigelse → hard-filter inkl. handelbarhed → én række pr. ticker.
 * Afviste rækker returneres med årsag, så intet forsvinder i stilhed.
 */
export async function buildScanRows(
  raw: InsiderTransaction[],
  opts: { enrich?: boolean } = {}
): Promise<{ rows: InsiderTransaction[]; rejected: RejectedRow[] }> {
  const rejected: RejectedRow[] = [];
  const reject = (tx: InsiderTransaction, reason: string) =>
    rejected.push({ id: tx.id, ticker: tx.ticker, insiderName: tx.insiderName, reason });

  const candidates = raw.filter((tx) => {
    const hf = applyHardFilter(tx); // kode P og beløb – handelbarhed er endnu ikke kendt
    if (!hf.passed) {
      reject(tx, hf.reason || 'Afvist af hard-filteret');
      return false;
    }
    if (dayIndex(tx.tradeDate) === undefined) {
      reject(tx, 'Afvist: Handelsdato mangler – handlen kan ikke placeres i et cluster-vindue.');
      return false;
    }
    if (!isValidInsiderName(tx.insiderName)) {
      reject(tx, `Afvist: "${tx.insiderName}" er en titel, ikke en person eller fond.`);
      return false;
    }
    return true;
  });

  const unique = dedupTrades(candidates);
  if (opts.enrich !== false) {
    await Promise.allSettled(unique.map((tx) => enrichTransactionWithMarketData(tx)));
  }

  const tradable = unique.filter((tx) => {
    const hf = applyHardFilter(tx);
    if (!hf.passed) reject(tx, hf.reason || 'Afvist af hard-filteret');
    return hf.passed;
  });

  return { rows: rollUpByTicker(tradable), rejected };
}

/**
 * Returnerer 6 hyper-realistiske mock-transaktioner til test af hele asymmetri-pipelinen.
 */
export function getMockTransactions(): InsiderTransaction[] {
  return [
    {
      id: 'mock-cfo-cluster-buy',
      tradeDate: '2026-10-22',
      ticker: 'NVCR',
      companyName: 'NovoCure Therapeutics Corp.',
      insiderName: 'Sarah Jenkins',
      insiderTitle: 'CFO',
      transactionCode: 'P',
      shares: 20000,
      pricePerShare: 24.0,
      totalValueUsd: 480000,
      sharesOwnedFollowing: 67619,
      holdingsIncreasePct: 42.0,
      isClusterBuy: true,
      clusterCount: 2,
      ownershipNature: 'D',
      isExecutiveOfficer: true,
      recentPriceChange30dPct: -28.0,
      currentMarketPrice: 22.8,
      atr14d: 0.95,
      dailyVolatilityPct: 4.17,
      supportLow30d: 21.5,
      resistanceHigh90d: 36.6,
      returnSinceBuyPct: -5.0,
      isTradingBelowInsiderPrice: true,
      exchange: 'NASDAQ',
      isTradableInDK: true,
      tradabilityReason: 'Verificeret: NASDAQ • Likviditet $18.4M/dag • Handelbar på Nordnet / Saxo',
      avgDailyDollarVolume: 18400000,
      secFilingUrl: 'https://www.sec.gov/edgar/data/1029384/000102938426000042/form4.xml',
      trackRecord: {
        historicalBuysCount: 2,
        winRatePct: 100,
        avgReturnPct: 53.6,
        reputation: 'SMART_MONEY_SNIPER',
        reputationLabel: '🎯 Smart Money Sniper (100% Win-Rate, Gns. +53.6%)',
        notablePastTrades: [
          {
            date: '2024-11-12',
            insiderName: 'Sarah Jenkins',
            insiderTitle: 'CFO',
            price: 14.5,
            valueUsd: 290000,
            returnPct: 57.2,
          },
          {
            date: '2024-11-14',
            insiderName: 'Marcus Hall',
            insiderTitle: 'General Counsel',
            price: 15.2,
            valueUsd: 182400,
            returnPct: 50.0,
          },
        ],
      },
      contextNotes:
        'Massivt CFO + General Counsel cluster-køb efter 28% kursfald grundet forsinket FDA-møde. Forøger CFOs beholdning med 42% ($480k).\n\nInsider Alpha: Købskurs $24.00 vs. Aktuel kurs $22.80 (RABAT: Handler 5.0% under insiderens købspris!)\n\nKurs-kontekst: Seneste lukkekurs $22.80 (-28.0% seneste 30d, -37.7% fra 3-mdr top $36.60).\n\nSeneste nyheder & katalysatorer:\n• [21 Oct] NovoCure clarifies timeline for FDA review meeting\n• [18 Oct] Analyst downgrade citing regulatory uncertainty',
    },
    {
      id: 'mock-ceo-cosmetic-buy',
      tradeDate: '2026-10-23',
      ticker: 'PLXR',
      companyName: 'Plexus Cloud Systems',
      insiderName: 'Marcus Vance',
      insiderTitle: 'CEO',
      transactionCode: 'P',
      shares: 5000,
      pricePerShare: 13.0,
      totalValueUsd: 65000,
      sharesOwnedFollowing: 1385000,
      holdingsIncreasePct: 0.36,
      isClusterBuy: false,
      clusterCount: 1,
      ownershipNature: 'D',
      isExecutiveOfficer: true,
      recentPriceChange30dPct: -45.0,
      currentMarketPrice: 11.7,
      atr14d: 0.88,
      dailyVolatilityPct: 7.52,
      supportLow30d: 11.2,
      resistanceHigh90d: 31.0,
      returnSinceBuyPct: -10.0,
      isTradingBelowInsiderPrice: true,
      exchange: 'NASDAQ',
      isTradableInDK: true,
      tradabilityReason: 'Verificeret: NASDAQ • Likviditet $4.2M/dag • Handelbar på Nordnet / Saxo',
      avgDailyDollarVolume: 4200000,
      secFilingUrl: 'https://www.sec.gov/edgar/data/1482910/000148291026000115/form4.xml',
      trackRecord: {
        historicalBuysCount: 3,
        winRatePct: 0,
        avgReturnPct: -49.0,
        reputation: 'EARLY_OR_BAGHOLDER',
        reputationLabel: '⚠️ Tidligere køb i minus (0% Win-Rate, Gns. -49.0%) - Bagholder-risiko',
        notablePastTrades: [
          {
            date: '2024-08-15',
            insiderName: 'Marcus Vance',
            insiderTitle: 'CEO',
            price: 28.0,
            valueUsd: 140000,
            returnPct: -58.2,
          },
          {
            date: '2024-11-20',
            insiderName: 'Marcus Vance',
            insiderTitle: 'CEO',
            price: 24.0,
            valueUsd: 120000,
            returnPct: -51.3,
          },
          {
            date: '2025-03-10',
            insiderName: 'Marcus Vance',
            insiderTitle: 'CEO',
            price: 19.0,
            valueUsd: 95000,
            returnPct: -38.4,
          },
        ],
      },
      contextNotes:
        'CEO "Cosmetic / PR Buy" i presset selskab. Køb for $65k er mikroskopisk mod en eksisterende beholdning på $18 mio. (kun +0.36% forøgelse).\n\nInsider Alpha: Købskurs $13.00 vs. Aktuel kurs $11.70 (RABAT: Handler 10.0% under insiderens købspris!)\n\nKurs-kontekst: Seneste lukkekurs $11.70 (-45.0% seneste 30d, -62.3% fra 3-mdr top $31.00).\n\nSeneste nyheder & katalysatorer:\n• [20 Oct] Plexus Cloud lowers ARR guidance for Q4\n• [15 Oct] Major enterprise customer churn reported',
    },
    {
      id: 'mock-chair-cfo-earnings-buy',
      tradeDate: '2026-10-21',
      ticker: 'MTLR',
      companyName: 'Vanguard Industrial Dynamics',
      insiderName: 'David K. Holm',
      insiderTitle: 'Chairman of the Board',
      transactionCode: 'P',
      shares: 10000,
      pricePerShare: 31.0,
      totalValueUsd: 310000,
      sharesOwnedFollowing: 45714,
      holdingsIncreasePct: 28.0,
      isClusterBuy: true,
      clusterCount: 2,
      ownershipNature: 'D',
      isExecutiveOfficer: true,
      recentPriceChange30dPct: 3.5,
      currentMarketPrice: 34.1,
      atr14d: 0.9,
      dailyVolatilityPct: 2.64,
      supportLow30d: 31.2,
      resistanceHigh90d: 35.8,
      returnSinceBuyPct: 10.0,
      isTradingBelowInsiderPrice: false,
      exchange: 'NYSE',
      isTradableInDK: true,
      tradabilityReason: 'Verificeret: NYSE • Likviditet $12.1M/dag • Handelbar på Nordnet / Saxo',
      avgDailyDollarVolume: 12100000,
      secFilingUrl: 'https://www.sec.gov/edgar/data/1129381/000112938126000089/form4.xml',
      trackRecord: {
        historicalBuysCount: 0,
        winRatePct: 0,
        avgReturnPct: 0,
        reputation: 'FIRST_TIME_OR_RARE',
        reputationLabel: '🆕 Sjældent signal: Første åbne markedskøb fra ledelsen i >3 år',
        notablePastTrades: [],
      },
      contextNotes:
        'Stille Bestyrelsesformand + CFO køb ($310.000, +28% beholdning) i overset industriaktie to uger før kvartalsregnskab.\n\nInsider Alpha: Købskurs $31.00 vs. Aktuel kurs $34.10 (Insider afkast siden køb: +10.0%)\n\nKurs-kontekst: Seneste lukkekurs $34.10 (+3.5% seneste 30d, +7.7% fra 3-mdr top $31.65).\n\nSeneste nyheder & katalysatorer:\n• [19 Oct] Vanguard wins $85M infrastructure supply contract\n• [10 Oct] Q3 earnings scheduled for release November 6',
    },
    {
      id: 'mock-option-exercise-m',
      tradeDate: '2026-10-24',
      ticker: 'MEDX',
      companyName: 'Medix Therapeutics Corp.',
      insiderName: 'Elena Rostova',
      insiderTitle: 'Chief Scientific Officer',
      transactionCode: 'M',
      shares: 40000,
      pricePerShare: 30.0,
      totalValueUsd: 1200000,
      sharesOwnedFollowing: 120000,
      holdingsIncreasePct: 50.0,
      isClusterBuy: false,
      ownershipNature: 'D',
      isExecutiveOfficer: true,
      secFilingUrl: 'https://www.sec.gov/edgar/data/1589302/000158930226000012/form4.xml',
      contextNotes:
        'Option exercise (M) på $1.200.000. Tildelt incitamentsprogram, ikke køb med egne opsparede midler på det åbne marked.',
    },
    {
      id: 'mock-director-small-buy',
      tradeDate: '2026-10-23',
      ticker: 'SOLR',
      companyName: 'Solaris Energy Group',
      insiderName: 'Arthur Pendelton',
      insiderTitle: 'Director',
      transactionCode: 'P',
      shares: 1000,
      pricePerShare: 18.5,
      totalValueUsd: 18500,
      sharesOwnedFollowing: 15000,
      holdingsIncreasePct: 7.1,
      isClusterBuy: false,
      ownershipNature: 'D',
      isExecutiveOfficer: false,
      currentMarketPrice: 17.9,
      returnSinceBuyPct: -3.24,
      isTradingBelowInsiderPrice: true,
      secFilingUrl: 'https://www.sec.gov/edgar/data/1392019/000139201926000005/form4.xml',
      contextNotes:
        'Småkøb (P) på $18.500 fra bestyrelsesmedlem. Under minimumsgrænsen på $50.000, typisk symbolsk eller støj.',
    },
    {
      id: 'mock-insider-sale-s',
      tradeDate: '2026-10-24',
      ticker: 'APEX',
      companyName: 'Apex Data Networks',
      insiderName: 'Jonathan Reiss',
      insiderTitle: 'CTO',
      transactionCode: 'S',
      shares: 15000,
      pricePerShare: 60.0,
      totalValueUsd: 900000,
      sharesOwnedFollowing: 85000,
      holdingsIncreasePct: -15.0,
      isClusterBuy: false,
      ownershipNature: 'D',
      isExecutiveOfficer: true,
      secFilingUrl: 'https://www.sec.gov/edgar/data/1209384/000120938426000201/form4.xml',
      contextNotes:
        'Insider Salg (S) på $900.000 under 10b5-1 plan. Bliver filtreret fra, da vi udelukkende screener for købsasymmetri.',
    },
    {
      id: 'mock-10b51-plan-buy',
      tradeDate: '2026-10-24',
      ticker: 'PLAN',
      companyName: 'Planar Automated Systems Inc.',
      insiderName: 'Robert Sterling',
      insiderTitle: 'Chief Operating Officer',
      transactionCode: 'P',
      shares: 10000,
      pricePerShare: 25.0,
      totalValueUsd: 250000,
      sharesOwnedFollowing: 55000,
      holdingsIncreasePct: 22.2,
      isClusterBuy: false,
      clusterCount: 1,
      ownershipNature: 'D',
      isExecutiveOfficer: true,
      is10b51Plan: true,
      footnotesSummary:
        '[F1] The purchases reported in this Form 4 were effected pursuant to a Rule 10b5-1 trading plan adopted by the Reporting Person on March 15, 2026.',
      recentPriceChange30dPct: -12.0,
      currentMarketPrice: 24.5,
      atr14d: 0.85,
      dailyVolatilityPct: 3.47,
      supportLow30d: 23.8,
      resistanceHigh90d: 29.5,
      returnSinceBuyPct: -2.0,
      isTradingBelowInsiderPrice: true,
      exchange: 'NASDAQ',
      isTradableInDK: true,
      tradabilityReason: 'Verificeret: NASDAQ • Likviditet $9.2M/dag • Handelbar på Nordnet / Saxo',
      avgDailyDollarVolume: 9200000,
      secFilingUrl: 'https://www.sec.gov/edgar/data/1999999/000199999926000001/form4.xml',
      trackRecord: {
        historicalBuysCount: 2,
        winRatePct: 50,
        avgReturnPct: 4.5,
        reputation: 'CREDIBLE_BUYER',
        reputationLabel: '📈 Kredibel køber (50% Win-Rate, Gns. +4.5%)',
        notablePastTrades: [
          {
            date: '2025-06-15',
            insiderName: 'Robert Sterling',
            insiderTitle: 'COO',
            price: 21.0,
            valueUsd: 105000,
            returnPct: 16.7,
          },
          {
            date: '2025-12-15',
            insiderName: 'Robert Sterling',
            insiderTitle: 'COO',
            price: 26.5,
            valueUsd: 132500,
            returnPct: -7.5,
          },
        ],
      },
      contextNotes:
        'SEC Form 4 Fodnoter (Det med småt):\n[F1] The purchases reported in this Form 4 were effected pursuant to a Rule 10b5-1 trading plan adopted by the Reporting Person on March 15, 2026.\n\nAutomatisk eksekveret køb under Rule 10b5-1 handelsplan indgået for 7 måneder siden. 0% aktuel informationsasymmetri.',
    },
  ];
}

// Rule 10b5-1 i en fodnote – men ikke når den negeres ("not made pursuant to a Rule 10b5-1 plan").
const PLAN_FOOTNOTE_RE = /10b5-?1|rule\s*10b5|pre-?arranged|automatic\s*(?:purchase|trading)|trading\s+plan/i;
const PLAN_NEGATION_RE =
  /\bnot\s+(?:been\s+)?(?:made\s+|effected\s+|executed\s+|entered\s+into\s+|done\s+)?(?:pursuant\s+to|under|in\s+accordance\s+with)\b/i;

export function isPlanFootnote(text: string): boolean {
  return PLAN_FOOTNOTE_RE.test(text) && !PLAN_NEGATION_RE.test(text);
}

/**
 * Rule 10b5-1 for købslinjerne i en Form 4: afkrydsningsfeltet <aff10b5One>, eller en fodnote, som en
 * P-linje refererer til via <footnoteId>. Fodnoter til andre linjer (fx et salg) tæller ikke,
 * og negationer ("not pursuant to") giver false.
 */
export function detect10b51(xml: string, code: 'P' | 'S' = 'P'): boolean {
  if (/<aff10b5One>\s*(1|true)\s*<\/aff10b5One>/i.test(xml)) return true;

  const footnotes = new Map<string, string>();
  for (const m of xml.matchAll(/<footnote\s+id=["']?([^"'>\s]+)["']?[^>]*>([\s\S]*?)<\/footnote>/gi)) {
    footnotes.set(m[1], m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  }

  const refIds = new Set<string>();
  for (const block of xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi)) {
    const lineCode = block[1].match(/<transactionCode>\s*([A-Za-z])\s*<\/transactionCode>/i)?.[1]?.toUpperCase();
    if (lineCode !== code) continue;
    for (const ref of block[1].matchAll(/<footnoteId\s+id=["']?([^"'\s/>]+)/gi)) refIds.add(ref[1]);
  }
  return [...refIds].some((id) => isPlanFootnote(footnotes.get(id) ?? ''));
}

interface ParsedSubTransaction {
  code: TransactionCode;
  isAcquisition: boolean;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  sharesOwnedFollowing?: number;
  tradeDate?: string;
}

const pct2 = (part: number, whole: number) => Number(((part / whole) * 100).toFixed(2));

/**
 * Parser og aggregerer ikke-derivat-transaktionslinjerne i en Form 4 (split-lots for samme insider lægges sammen).
 * Kode P accepteres kun med acquiredDisposedCode 'A'. Derivat-linjer kan aldrig blive til et aktiekøb:
 * uden <nonDerivativeTransaction>-blokke returneres null.
 * Mangler beholdningen, er holdingsIncreasePct undefined – aldrig et opfundet tal.
 */
export function parseAndAggregateTransactions(xml: string): {
  code: TransactionCode;
  shares: number;
  pricePerShare: number;
  totalValueUsd: number;
  sharesOwnedFollowing?: number;
  holdingsIncreasePct?: number;
  tradeDate?: string;
} | null {
  const txMatches = [...xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi)];
  if (txMatches.length === 0) return null;

  const parsedSubTxs: ParsedSubTransaction[] = [];
  for (const match of txMatches) {
    const block = match[1];
    const codeMatch = block.match(/<transactionCoding>[\s\S]*?<transactionCode>\s*([A-Za-z])\s*<\/transactionCode>/i);
    const adMatch = block.match(/<transactionAcquiredDisposedCode>\s*<value>\s*([A-Za-z])\s*<\/value>/i);
    const rawCode = (codeMatch ? codeMatch[1].toUpperCase() : '') as TransactionCode;
    const adCode = adMatch ? adMatch[1].toUpperCase() : '';
    if (!rawCode) continue;

    const sharesStr = block.match(/<transactionShares>\s*<value>\s*(.*?)\s*<\/value>/i)?.[1]?.trim();
    const priceStr = block.match(/<transactionPricePerShare>\s*<value>\s*(.*?)\s*<\/value>/i)?.[1]?.trim();
    const ownedFollowingStr = block.match(/<sharesOwnedFollowingTransaction>\s*<value>\s*(.*?)\s*<\/value>/i)?.[1]?.trim();
    const tradeDate = block.match(/<transactionDate>\s*<value>\s*(\d{4}-\d{2}-\d{2})/i)?.[1];

    const shares = parseFloat(sharesStr || '0');
    const price = parseFloat(priceStr || '0');
    const ownedFollowing = ownedFollowingStr ? parseFloat(ownedFollowingStr) : NaN;

    // Et åbent markedskøb SKAL være eksplicit kode 'P' OG have acquiredDisposedCode 'A' (Acquired)
    const isTruePurchase = rawCode === 'P' && adCode === 'A';
    const validCode: TransactionCode = isTruePurchase
      ? 'P'
      : ['S', 'A', 'M', 'F', 'G', 'D'].includes(rawCode)
      ? rawCode
      : adCode === 'D'
      ? 'S'
      : 'A';

    parsedSubTxs.push({
      code: validCode,
      isAcquisition: adCode === 'A',
      shares,
      pricePerShare: price,
      totalValue: shares * price,
      sharesOwnedFollowing: Number.isFinite(ownedFollowing) ? ownedFollowing : undefined,
      tradeDate,
    });
  }
  if (parsedSubTxs.length === 0) return null;

  // Prioriter Open Market Purchases ('P' med 'A') og aggreger alle del-linjer
  const pTransactions = parsedSubTxs.filter((t) => t.code === 'P');
  if (pTransactions.length > 0) {
    const totalShares = pTransactions.reduce((acc, t) => acc + t.shares, 0);
    const totalValueUsd = pTransactions.reduce((acc, t) => acc + t.totalValue, 0);
    const avgPrice = totalShares > 0 ? Number((totalValueUsd / totalShares).toFixed(4)) : pTransactions[0].pricePerShare;
    const owned = pTransactions.map((t) => t.sharesOwnedFollowing).filter((n): n is number => n !== undefined);
    const sharesOwnedFollowing = owned.length > 0 ? Math.max(...owned) : undefined;
    const priorShares = sharesOwnedFollowing !== undefined ? sharesOwnedFollowing - totalShares : undefined;
    const dates = pTransactions.map((t) => t.tradeDate).filter((d): d is string => Boolean(d)).sort();

    return {
      code: 'P',
      shares: totalShares,
      pricePerShare: avgPrice,
      totalValueUsd,
      sharesOwnedFollowing,
      holdingsIncreasePct: priorShares !== undefined && priorShares > 0 ? pct2(totalShares, priorShares) : undefined,
      tradeDate: dates[dates.length - 1],
    };
  }

  // Ingen 'P': returnér første linje (F, S, M, A …) – den afvises senere af hard-filteret.
  const primaryTx = parsedSubTxs[0];
  const prior =
    primaryTx.sharesOwnedFollowing !== undefined
      ? primaryTx.sharesOwnedFollowing - (primaryTx.isAcquisition ? primaryTx.shares : -primaryTx.shares)
      : undefined;
  return {
    code: primaryTx.code,
    shares: primaryTx.shares,
    pricePerShare: primaryTx.pricePerShare,
    totalValueUsd: primaryTx.totalValue,
    sharesOwnedFollowing: primaryTx.sharesOwnedFollowing,
    holdingsIncreasePct: prior !== undefined && prior > 0 ? pct2(primaryTx.shares, prior) : undefined,
    tradeDate: primaryTx.tradeDate,
  };
}

/**
 * Henter og parser en individuel Form 4 XML filing givet dens Atom-indhold.
 * Fejl i én indberetning giver null (logges); fejl i selve feedet håndteres af kalderen.
 */
async function parseForm4Entry(
  entryContent: string,
  defaultTicker?: string,
  defaultCompanyName?: string
): Promise<InsiderTransaction | null> {
  const linkMatch = entryContent.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (!linkMatch) return null;

  let indexUrl = linkMatch[1];
  if (!indexUrl.startsWith('http')) {
    indexUrl = 'https://www.sec.gov' + indexUrl;
  }
  // SEC's accept-tidspunkt for indberetningen (Atom <updated>), ikke handelsdatoen.
  const filedAt = entryContent.match(/<updated>\s*([^<]+?)\s*<\/updated>/i)?.[1];
  const accessionNo = accessionFromUrl(indexUrl);

  try {
    const indexResponse = await secFetch(indexUrl, { accept: 'text/html' });
    if (!indexResponse.ok) return null;

    const indexHtml = await indexResponse.text();
    const xmlMatch = indexHtml.match(/href=["'](\/Archives\/edgar\/data\/[^"']+\.xml)["']/i);
    if (!xmlMatch) return null;

    // Strip stylesheet prefix (f.eks. /xslF345X06/) for at få den rå XML-fil
    const rawXmlPath = xmlMatch[1].replace(/\/xsl[^\/]+\//i, '/');
    const rawXmlUrl = 'https://www.sec.gov' + rawXmlPath;

    const xmlResponse = await secFetch(rawXmlUrl, { accept: 'application/xml, text/xml' });
    if (!xmlResponse.ok) return null;

    const xml = await xmlResponse.text();

    // Udtræk selskabs- og ejer-info
    const tickerFromXml = xml.match(/<issuerTradingSymbol>\s*(.*?)\s*<\/issuerTradingSymbol>/i)?.[1]?.trim();
    const ticker = tickerFromXml || defaultTicker;
    const companyFromXml = xml.match(/<issuerName>\s*(.*?)\s*<\/issuerName>/i)?.[1]?.trim();
    const companyName = companyFromXml || defaultCompanyName || ticker;
    const insiderName = xml.match(/<rptOwnerName>\s*(.*?)\s*<\/rptOwnerName>/i)?.[1]?.trim();
    const ownerCik = xml.match(/<rptOwnerCik>\s*0*(\d+)\s*<\/rptOwnerCik>/i)?.[1];

    if (!ticker || !insiderName || !isValidInsiderName(insiderName)) return null;

    // Udtræk og aggreger del-linjer (split-lots)
    const aggregated = parseAndAggregateTransactions(xml);
    if (!aggregated) return null;

    // Udtræk titel / rolle
    let insiderTitle = xml.match(/<officerTitle>\s*(.*?)\s*<\/officerTitle>/i)?.[1]?.trim();
    if (!insiderTitle) {
      if (/<isDirector>\s*(1|true)\s*<\/isDirector>/i.test(xml)) {
        insiderTitle = 'Director';
      } else if (/<isTenPercentOwner>\s*(1|true)\s*<\/isTenPercentOwner>/i.test(xml)) {
        insiderTitle = '10% Owner';
      } else if (/<isOfficer>\s*(1|true)\s*<\/isOfficer>/i.test(xml)) {
        insiderTitle = 'Officer';
      } else {
        insiderTitle = 'Insider';
      }
    }

    // Handelsdato: seneste transactionDate på P-linjerne; periodOfReport som reserve (også en handelsdato).
    const tradeDate =
      aggregated.tradeDate || xml.match(/<periodOfReport>\s*(\d{4}-\d{2}-\d{2})\s*<\/periodOfReport>/i)?.[1];

    const ownershipVal = xml
      .match(/<directOrIndirectOwnership>\s*<value>\s*([DI])\s*<\/value>/i)?.[1]
      ?.toUpperCase();
    const ownershipNature: 'D' | 'I' = ownershipVal === 'I' ? 'I' : 'D';
    const isExecutiveOfficer =
      isExecutiveTitle(insiderTitle) || /<isOfficer>\s*(1|true)\s*<\/isOfficer>/i.test(xml);

    // Rule 10b5-1: afkrydsningsfeltet eller en fodnote, som købslinjerne selv refererer til
    const is10b51Plan = detect10b51(xml);

    // Udtræk alle fodnoter fra <footnotes> sektionen
    const footnoteMatches = [...xml.matchAll(/<footnote\s+id=["']?([^"'>]+)["']?>([\s\S]*?)<\/footnote>/gi)];
    const footnotesSummary = footnoteMatches
      .map((m) => `[${m[1]}] ${m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`)
      .join('\n');


    const transaction: InsiderTransaction = {
      id:
        accessionNo && ownerCik
          ? `sec-${accessionNo}-${ownerCik}`
          : `sec-${ticker}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      tradeDate,
      filedAt,
      accessionNo,
      ownerCik,
      ticker,
      companyName: companyName || ticker,
      insiderName,
      insiderTitle,
      transactionCode: aggregated.code,
      shares: aggregated.shares,
      pricePerShare: aggregated.pricePerShare,
      currency: 'USD',
      totalValueUsd: aggregated.totalValueUsd,
      sharesOwnedFollowing: aggregated.sharesOwnedFollowing,
      holdingsIncreasePct: aggregated.holdingsIncreasePct,
      isClusterBuy: false,
      clusterCount: 1,
      ownershipNature,
      isExecutiveOfficer,
      is10b51Plan,
      footnotesSummary: footnotesSummary || undefined,
      secFilingUrl: rawXmlUrl,
      contextNotes: footnotesSummary
        ? `SEC Form 4 Fodnoter (Det med småt):\n${footnotesSummary}`
        : undefined,
    };

    return transaction;
  } catch (err) {
    console.warn(`Fejl ved parsing af ${indexUrl}:`, err);
    return null;
  }
}

/**
 * In-memory cache for SEC company tickers -> CIK opslag.
 */
let tickerCikCache: Map<string, { cik: string; title: string }> | null = null;

/**
 * Slår en tickers 10-cifrede CIK-nummer op via SEC company_tickers.json.
 */
export async function getCikForTicker(ticker: string): Promise<{ cik: string; title: string } | null> {
  const cleanTicker = ticker.trim().toUpperCase();

  if (tickerCikCache && tickerCikCache.has(cleanTicker)) {
    return tickerCikCache.get(cleanTicker)!;
  }

  try {
    const res = await secFetch('https://www.sec.gov/files/company_tickers.json', { accept: 'application/json' });

    if (!res.ok) return null;

    const data = await res.json();
    const map = new Map<string, { cik: string; title: string }>();

    for (const item of Object.values(data) as Array<{ cik_str: number; ticker: string; title: string }>) {
      if (item && item.ticker) {
        map.set(item.ticker.toUpperCase(), {
          cik: String(item.cik_str),
          title: item.title,
        });
      }
    }

    tickerCikCache = map;
    return tickerCikCache.get(cleanTicker) || null;
  } catch (err) {
    console.warn('Kunne ikke hente SEC company_tickers.json:', err);
    return null;
  }
}

const OPENINSIDER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

/**
 * Henter en OpenInsider-screenerside. Kaster ved netværksfejl, timeout og HTTP-fejl, så en fejl aldrig ligner "ingen signaler".
 * ponytail: kun http – openinsider.com svarer ikke på https (port 443 lukket, tjekket 4.11.2026). SEC-links omskrives til https.
 */
export async function fetchOpenInsiderHtml(query: string, timeoutMs = 8000): Promise<string> {
  const res = await fetch(`http://openinsider.com/screener?${query}`, {
    headers: OPENINSIDER_HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`OpenInsider svarede ${res.status}`);
  return res.text();
}

const cellText = (html?: string) =>
  (html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();

/**
 * Parser OpenInsider's tinytable. Kolonner findes ud fra overskrifterne (Filing Date, Trade Date, Ticker,
 * Insider Name, Title, Trade Type, Price, Qty, Owned, ΔOwn, Value). Transaktionskoden læses fra "Trade Type".
 * - Ingen tabel på en ellers gyldig screenerside = 0 rækker.
 * - Ingen genkendelig side eller manglende nøglekolonner kaster (parse-fejl ≠ ingen handler).
 */
export function parseOpenInsiderTable(html: string, idPrefix: string): InsiderTransaction[] {
  const tableMatch = html.match(/<table[^>]*class=["']tinytable["'][\s\S]*?<\/table>/i);
  if (!tableMatch) {
    if (/Sort by[\s\S]*Max Results/i.test(html)) return [];
    throw new Error('OpenInsider-siden kunne ikke læses (hverken resultattabel eller screener fundet)');
  }

  const trMatches = [...tableMatch[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)];
  if (trMatches.length < 1) return [];

  const thHeaders = [...trMatches[0][0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => cellText(m[1]).toLowerCase());
  const col = (pred: (h: string) => boolean) => thHeaders.findIndex(pred);
  const colFiling = col((h) => h.includes('filing'));
  const colTrade = col((h) => h.includes('trade date'));
  const colTicker = col((h) => h.includes('ticker'));
  const colCompany = col((h) => h.includes('company'));
  const colInsider = col((h) => h.includes('insider'));
  const colTitle = col((h) => h === 'title');
  const colType = col((h) => h.includes('trade type'));
  const colPrice = col((h) => h.includes('price'));
  const colQty = col((h) => h.includes('qty'));
  const colOwned = col((h) => h.includes('owned'));
  const colDeltaOwn = col((h) => h.includes('own') && (h.includes('δ') || h.includes('&delta;') || h.includes('delta')));
  const colValue = col((h) => h.includes('value'));

  if ([colTicker, colInsider, colPrice, colQty, colType, colTrade].some((c) => c === -1)) {
    throw new Error(`OpenInsider-tabellen mangler nøglekolonner (fandt: ${thHeaders.join(' | ')})`);
  }

  const transactions: InsiderTransaction[] = [];
  for (let i = 1; i < trMatches.length; i++) {
    const rowHtml = trMatches[i][0];
    const td = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (td.length < thHeaders.length - 4) continue;

    const filingRaw = colFiling !== -1 ? cellText(td[colFiling]) : '';
    // Filing Date er SEC's accept-tidspunkt i ET (uden tidszone) – gemmes som det står.
    const filedAt = /^\d{4}-\d{2}-\d{2}/.test(filingRaw) ? filingRaw.replace(' ', 'T') : undefined;
    const tradeDate = cellText(td[colTrade]).match(/^\d{4}-\d{2}-\d{2}/)?.[0];

    const secLink = (colFiling !== -1 ? td[colFiling] : rowHtml).match(
      /href="(https?:\/\/(?:www\.)?sec\.gov\/Archives\/edgar\/data\/[^\s"'>]+)"/i
    )?.[1];
    const secFilingUrl = secLink ? secLink.replace(/^http:\/\/(?:www\.)?sec\.gov/i, 'https://www.sec.gov') : undefined;
    const accessionNo = accessionFromUrl(secFilingUrl);

    const tickerMatch = td[colTicker]?.match(/href="\/([A-Za-z0-9.\-]+)"/i) || td[colTicker]?.match(/>([A-Z0-9.\-]+)<\/a>/i);
    const ticker = tickerMatch ? tickerMatch[1].toUpperCase() : '';
    if (!ticker) continue;

    const companyName = colCompany !== -1 ? cellText(td[colCompany]) || ticker : ticker;
    const insiderName = cellText(td[colInsider]);
    const ownerCik = td[colInsider]?.match(/href="\/insider\/[^"\/]+\/0*(\d+)"/i)?.[1];
    const insiderTitle = colTitle !== -1 ? cellText(td[colTitle]) || 'Insider' : 'Insider';

    // "P - Purchase", "S - Sale", "S - Sale+OE", "M - OptEx" … – første bogstav er Form 4-koden.
    const typeCode = cellText(td[colType]).match(/^([A-Z])\s*-/)?.[1] as TransactionCode | undefined;
    if (!typeCode) continue;

    const pricePerShare = parseFloat(cellText(td[colPrice]).replace(/[$,]/g, '')) || 0;
    const shares = Math.abs(parseInt(cellText(td[colQty]).replace(/[+,\s]/g, ''), 10)) || 0;

    const ownedRaw = colOwned !== -1 ? cellText(td[colOwned]).replace(/,/g, '') : '';
    const sharesOwnedFollowing = /^\d+$/.test(ownedRaw) ? parseInt(ownedRaw, 10) : undefined;

    // ΔOwn: "+3%" → 3. "New" (ny beholdning) og manglende værdi → undefined, aldrig et opfundet tal.
    const deltaRaw = colDeltaOwn !== -1 ? cellText(td[colDeltaOwn]).replace(/[%,\s]/g, '').replace(/^\+/, '') : '';
    const deltaNum = parseFloat(deltaRaw);
    const holdingsIncreasePct = Number.isFinite(deltaNum) && !/new/i.test(deltaRaw) ? deltaNum : undefined;

    const valueNum = parseFloat((colValue !== -1 ? cellText(td[colValue]) : '').replace(/[+\-$,\s]/g, ''));
    const totalValueUsd = Number.isFinite(valueNum) && valueNum > 0 ? valueNum : shares * pricePerShare;

    const ownershipHint = td[colInsider]?.match(/title="([^"]*)"/i)?.[1] || '';
    const ownershipNature: 'D' | 'I' = /indirect shares/i.test(ownershipHint)
      ? 'I'
      : /direct shares/i.test(ownershipHint)
      ? 'D'
      : detectOwnershipNature(undefined, insiderName, rowHtml);

    transactions.push({
      id:
        accessionNo && ownerCik
          ? `oi-${accessionNo}-${ownerCik}`
          : `${idPrefix}-${ticker}-${tradeDate}-${shares}-${Math.round(totalValueUsd)}`,
      tradeDate,
      filedAt,
      accessionNo,
      ownerCik,
      ticker,
      companyName,
      insiderName,
      insiderTitle,
      transactionCode: typeCode,
      shares,
      pricePerShare,
      currency: 'USD',
      totalValueUsd,
      sharesOwnedFollowing,
      holdingsIncreasePct,
      isClusterBuy: false,
      clusterCount: 1,
      ownershipNature,
      isExecutiveOfficer: isExecutiveTitle(insiderTitle),
      is10b51Plan: undefined, // OpenInsider viser hverken fodnoter eller 10b5-1-feltet → ukendt (afgøres fra Form 4 i rådet)
      secFilingUrl: secFilingUrl || 'https://www.sec.gov',
    });
  }

  return transactions;
}

/**
 * Åbne markedskøb (kode P, ≥ $50k) fra OpenInsider de seneste dage. Kaster ved fejl.
 * 'officer' = kun Form 4 med isOfficer (C-suite), 'general' = alle insidere. Ingen berigelse eller clustering her –
 * det sker samlet i buildScanRows, så hver kilde kun hentes én gang pr. scan.
 */
export async function fetchOpenInsiderBuys(kind: 'officer' | 'general', limit = 25): Promise<InsiderTransaction[]> {
  const query =
    kind === 'officer'
      ? `s=&o=&pl=&ph=&ll=&lh=&fd=30&fdr=&td=0&tdr=&xp=1&isofficer=1&vl=50&vh=&sortcol=0&cnt=${limit}&page=1`
      : `s=&o=&pl=&ph=&ll=&lh=&fd=14&fdr=&td=0&tdr=&xp=1&vl=50&vh=&sortcol=0&cnt=${limit}&page=1`;
  const rows = parseOpenInsiderTable(await fetchOpenInsiderHtml(query), kind === 'officer' ? 'exec-buy' : 'live-buy');
  // Form 4's isOfficer-flag (OpenInsider-filteret) er mere pålideligt end titelteksten.
  if (kind === 'officer') for (const tx of rows) tx.isExecutiveOfficer = true;
  return rows;
}

/** Atom-feedets entries → parsede Form 4-transaktioner (8 ad gangen; SEC-klienten holder 8 req/s). */
async function parseAtomEntries(feedXml: string, maxEntries: number, ticker?: string, companyName?: string) {
  const entries = [...feedXml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, maxEntries);
  const transactions: InsiderTransaction[] = [];
  for (let i = 0; i < entries.length; i += 8) {
    const chunk = await Promise.all(entries.slice(i, i + 8).map((m) => parseForm4Entry(m[1], ticker, companyName)));
    for (const tx of chunk) if (tx) transactions.push(tx);
  }
  return transactions;
}

/** De seneste Form 4-indberetninger fra SEC EDGAR's "current"-feed. Kaster, hvis feedet ikke kan hentes. */
export async function fetchEdgarCurrentForm4s(maxEntries = 16): Promise<InsiderTransaction[]> {
  const feedUrl =
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=only&start=0&count=40&output=atom';
  const res = await secFetch(feedUrl, { accept: 'application/atom+xml, application/xml, text/xml' });
  if (!res.ok) throw new Error(`SEC EDGAR current-feed svarede ${res.status}`);
  return parseAtomEntries(await res.text(), maxEntries);
}

/**
 * On-demand SEC-scan af én US-ticker: CIK-opslag, selskabets egne Form 4-indberetninger, aggregerede del-handler.
 * Kaster ved ukendt ticker eller feed-fejl. Berigelse og roll-up sker i buildScanRows.
 */
export async function scanTickerSecForm4s(ticker: string): Promise<InsiderTransaction[]> {
  const cleanTicker = ticker.trim().toUpperCase();
  const cikInfo = await getCikForTicker(cleanTicker);
  if (!cikInfo) throw new Error(`Kunne ikke finde et SEC CIK-nummer for tickeren '${cleanTicker}'`);

  const feedUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(
    cikInfo.cik
  )}&type=4&owner=only&count=15&output=atom`;
  const res = await secFetch(feedUrl, { accept: 'application/atom+xml, application/xml, text/xml' });
  if (!res.ok) throw new Error(`SEC Atom-feed for ${cleanTicker} svarede ${res.status}`);
  return parseAtomEntries(await res.text(), 12, cleanTicker, cikInfo.title);
}

/**
 * Henter og udtrækker de juridiske fodnoter (<footnotes>) fra en Form 4 filing via SEC EDGAR.
 * Stripper automatisk eventuelle XSLT-stylesheets (/xslF345.../) for at hente den rå XML.
 */
export async function fetchSecForm4Footnotes(
  secUrl?: string
): Promise<{ footnotes: string[]; is10b51Plan?: boolean }> {
  if (!secUrl) return { footnotes: [] };
  // SSRF-værn: URL'en kan komme fra en klient – kun https://www.sec.gov accepteres (kaster ellers).
  assertSecUrl(secUrl, ['www.sec.gov']);
  const cleanUrl = secUrl.replace(/\/xsl[^\/]+\//i, '/');

  try {
    const res = await secFetch(cleanUrl, {
      accept: 'application/xml, text/xml, text/html, */*',
      timeoutMs: 6000,
      allowedHosts: ['www.sec.gov'],
    });

    if (!res.ok) return { footnotes: [] };

    let text = await res.text();

    // Hvis det var et index-dokument i stedet for direkte XML, find XML-linket
    if (cleanUrl.endsWith('.htm') || cleanUrl.endsWith('.html') || !cleanUrl.endsWith('.xml')) {
      const xmlMatch = text.match(/href=["'](\/Archives\/edgar\/data\/[^"']+\.xml)["']/i);
      if (xmlMatch) {
        const rawXmlUrl = 'https://www.sec.gov' + xmlMatch[1].replace(/\/xsl[^\/]+\//i, '/');
        const xmlRes = await secFetch(rawXmlUrl, { accept: 'application/xml, text/xml', allowedHosts: ['www.sec.gov'] });
        if (xmlRes.ok) {
          text = await xmlRes.text();
        }
      }
    }

    const is10b51Plan = /<ownershipDocument>/i.test(text) ? detect10b51(text) : undefined;
    const footnotesBlock = text.match(/<footnotes>([\s\S]*?)<\/footnotes>/i);
    if (!footnotesBlock) {
      return { footnotes: [], is10b51Plan };
    }

    const matches = [...footnotesBlock[1].matchAll(/<footnote id=["']([^"']+)["']>([\s\S]*?)<\/footnote>/gi)];
    const footnotes = matches
      .map((m) => {
        const id = m[1];
        const cleanText = m[2]
          .replace(/<[^>]+>/g, '')
          .replace(/&quot;/g, '"')
          .replace(/&apos;|&#39;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .replace(/\s+/g, ' ')
          .trim();
        return `[${id}] ${cleanText}`;
      })
      .filter((fn) => fn.length > 5);
    return { footnotes, is10b51Plan };
  } catch (err) {
    console.warn(`Kunne ikke hente SEC fodnoter fra ${secUrl}:`, err);
    return { footnotes: [] };
  }
}

