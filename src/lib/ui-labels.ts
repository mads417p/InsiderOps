import type { CompanyFundamentals, GatekeeperResult, InsiderTransaction, RejectedRow } from '@/types/insider';
import { currencyForTicker } from '@/lib/live-quote';

export type LabelTone = 'good' | 'bad' | 'neutral' | 'unknown';
export const TONE_CLASS: Record<LabelTone, string> = {
  good: 'text-gain',
  bad: 'text-loss',
  neutral: 'text-accent',
  unknown: 'text-graphite', // ukendt er gråt – aldrig en positiv farve
};

/**
 * Udvandings-label ud fra runway. Ukendt runway (undefined) er "Runway ukendt" – aldrig "Ingen udvandingsfare".
 * estimatedRunwayMonths === null betyder cash-flow positiv (se fundamentals.ts).
 */
export function runwayLabel(f: Pick<CompanyFundamentals, 'estimatedRunwayMonths' | 'isCashFlowPositive'>): { text: string; tone: LabelTone } {
  if (f.isCashFlowPositive === true || f.estimatedRunwayMonths === null) return { text: 'Cash-flow positiv', tone: 'good' };
  if (f.estimatedRunwayMonths === undefined || !Number.isFinite(f.estimatedRunwayMonths)) return { text: 'Runway ukendt', tone: 'unknown' };
  if (f.estimatedRunwayMonths < 9) return { text: 'Akut emissionsrisiko', tone: 'bad' };
  return { text: 'Ingen udvandingsfare', tone: 'good' };
}

/**
 * Alle afviste rækker i en scan: dem pipelinen afviste (kode, beløb, handelbarhed, Norden …) plus
 * items, der ikke bestod hard-filteret (kun i ældre gemte scans). Dedup på id.
 */
export function collectRejected(
  scanRejected: RejectedRow[],
  items: Array<{ transaction: Pick<InsiderTransaction, 'id' | 'ticker' | 'insiderName'>; result: Pick<GatekeeperResult, 'passedHardFilter' | 'hardFilterReason'> }>
): RejectedRow[] {
  const out = new Map(scanRejected.map((r) => [r.id, r]));
  for (const { transaction: t, result: r } of items) {
    if (!r.passedHardFilter && !out.has(t.id)) {
      out.set(t.id, { id: t.id, ticker: t.ticker, insiderName: t.insiderName, reason: r.hardFilterReason || 'Afvist af hard-filteret' });
    }
  }
  return [...out.values()];
}

/**
 * Kun en model-score (Claude eller Gemini) må starte auto-køen. Allow-list: ældre gemte scans uden
 * scoreSource og heuristiske scorer giver false.
 */
export const isModelScore = (r: Pick<GatekeeperResult, 'scoreSource'>): boolean =>
  r.scoreSource === 'claude' || r.scoreSource === 'gemini';

/**
 * Visningsnavn for rådets dom. Kun visning – DB, ledger og LLM bruger stadig de rå værdier.
 * Ingen dokumenteret edge (fase 4/4-SE), så UI siger "signal", aldrig "KØB".
 */
const VERDICT_LABEL: Record<string, string> = {
  'STRONG ASYMMETRY (KØB)': 'Stærkt signal',
  'MODERATE SIGNAL (OVERVÅG)': 'Overvåg',
  'PR STUNT / STØJ (IGNORER)': 'Støj',
};
export const verdictLabel = (v: string): string => VERDICT_LABEL[v] ?? v;

/** Samme grænser som scoren altid har brugt: ≥75 stærkt signal, ≥60 overvåg, ellers støj. */
export const scoreLabel = (score: number): string => (score >= 75 ? 'Stærkt signal' : score >= 60 ? 'Overvåg' : 'Støj');

// Samme rolle-regler som research (common.py CEO_RE/CFO_RE, se.py VD/CFO) – plus danske, norske og finske titler.
const CEO_CFO_RE =
  /(?<![\p{L}\p{N}])(ceo|chief executive|cfo|chief financial|vd|verkställande|koncernchef|ekonomichef|finanschef|ekonomidirekt\p{L}*|finansdirekt\p{L}*|økonomidirekt\p{L}*|administrerende direktør|adm\. ?direktør|konsernsjef|toimitusjohtaja|talousjohtaja|managing director|finance director)(?![\p{L}\p{N}])/iu;

/** Radar-preset "CEO/CFO-køb": lead-insiderens titel eller en af cluster-købernes. */
export function isCeoCfoBuy(t: Pick<InsiderTransaction, 'insiderTitle' | 'clusterBuyers'>): boolean {
  return [t.insiderTitle, ...(t.clusterBuyers ?? []).map((b) => b.title)].some((title) => CEO_CFO_RE.test(title ?? ''));
}

// --- Visningshjælpere flyttet uændret fra page.tsx (UI-redesign). Flag er erstattet af en tekstkode. ---

/** Valutamærke for insiderens kurs (tx.currency) og for markedskursen (børsens valuta). */
export const curLabel = (c: string) => (c === 'USD' ? '$' : `${c} `);
export const priceLabel = (tx: Pick<InsiderTransaction, 'currency'>) => curLabel((tx.currency || 'USD').toUpperCase());
export const marketPriceLabel = (ticker: string) => curLabel(currencyForTicker(ticker));

export function formatQuoteTime(isoOrStr?: string): string {
  if (!isoOrStr) return 'ukendt';
  try {
    const d = new Date(isoOrStr);
    if (!isNaN(d.getTime())) {
      return d.toLocaleString('da-DK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
  } catch {}
  return isoOrStr;
}

export function formatDateTimeDk(isoOrStr?: string): string {
  if (!isoOrStr) return 'Ukendt tidspunkt';
  try {
    const d = new Date(isoOrStr);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString('da-DK', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    }
  } catch {}
  return isoOrStr;
}

export function getRegionBadge(ticker: string, exchange?: string): { code: string; label: string } {
  const t = (ticker || '').toUpperCase();
  const ex = (exchange || '').toUpperCase();
  if (t.endsWith('.CO') || ex.includes('COPENHAGEN') || ex.includes('CPH')) return { code: 'DK', label: 'Danmark (Nasdaq Copenhagen)' };
  if (t.endsWith('.ST') || ex.includes('STOCKHOLM') || ex.includes('STO')) return { code: 'SE', label: 'Sverige (Nasdaq Stockholm)' };
  if (t.endsWith('.HE') || ex.includes('HELSINKI') || ex.includes('HEL')) return { code: 'FI', label: 'Finland (Nasdaq Helsinki)' };
  return { code: 'USA', label: 'USA (NYSE / NASDAQ)' };
}

/**
 * Fjerner emojis fra tekst, der kommer fra lib, gemte data eller LLM (fx "💎 Discount …"), før den vises.
 * Kun visning: DB, memo og ledger beholder den oprindelige tekst.
 */
export const stripEmoji = (s: string | undefined): string =>
  (s ?? '').replace(/(\p{Extended_Pictographic}|\p{Regional_Indicator})[️‍]*/gu, '').replace(/\s{2,}/g, ' ').trim();

/** Gns. daglig omsætning i dollar, kort: $12.3M / $450k (samme format som før). */
export const formatDailyVolume = (usd: number) => (usd >= 1_000_000 ? `$${(usd / 1_000_000).toFixed(1)}M` : `$${Math.round(usd / 1000)}k`);
