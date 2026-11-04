import type { GatekeeperResult, InsiderTransaction, RejectedRow } from '@/types/insider';

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
