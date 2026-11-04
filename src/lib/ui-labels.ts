import type { CompanyFundamentals, GatekeeperResult, InsiderTransaction, RejectedRow } from '@/types/insider';

export type LabelTone = 'good' | 'bad' | 'neutral' | 'unknown';
export const TONE_CLASS: Record<LabelTone, string> = {
  good: 'text-emerald-400',
  bad: 'text-rose-400',
  neutral: 'text-cyan-400',
  unknown: 'text-slate-500', // ukendt er gråt – aldrig en positiv farve
};

/**
 * Udvandings-label ud fra runway. Ukendt runway (undefined) er "Runway ukendt" – aldrig "Ingen udvandingsfare".
 * estimatedRunwayMonths === null betyder cash-flow positiv (se fundamentals.ts).
 */
export function runwayLabel(f: Pick<CompanyFundamentals, 'estimatedRunwayMonths' | 'isCashFlowPositive'>): { text: string; tone: LabelTone } {
  if (f.isCashFlowPositive === true || f.estimatedRunwayMonths === null) return { text: '🛡️ Cash-flow positiv', tone: 'good' };
  if (f.estimatedRunwayMonths === undefined || !Number.isFinite(f.estimatedRunwayMonths)) return { text: 'Runway ukendt', tone: 'unknown' };
  if (f.estimatedRunwayMonths < 9) return { text: '⚠️ Akut emissionsrisiko', tone: 'bad' };
  return { text: '🛡️ Ingen udvandingsfare', tone: 'good' };
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
