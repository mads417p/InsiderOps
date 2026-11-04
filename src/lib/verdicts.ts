import type { CouncilVerdict, InsiderTransaction } from '@/types/insider';

type VerdictEntry = { transaction: Pick<InsiderTransaction, 'ticker'>; verdict: CouncilVerdict; savedAt?: string };

const timeOf = (e: VerdictEntry) => Date.parse(e.verdict.evaluatedAt ?? e.verdict.timestamp ?? e.savedAt ?? '') || 0;

/**
 * Nyeste validerede dom for en ticker. Domme gemmes pr. transaktions-id, så én ticker kan have flere;
 * ikke-validerede (før fase 1) tæller ikke.
 */
export function latestValidatedVerdict(
  verdicts: Record<string, VerdictEntry>,
  ticker: string
): { verdict: CouncilVerdict; at: string | undefined } | null {
  const t = ticker.trim().toUpperCase();
  let best: VerdictEntry | null = null;
  for (const e of Object.values(verdicts)) {
    if (e.verdict.validated !== true || e.transaction.ticker?.trim().toUpperCase() !== t) continue;
    if (!best || timeOf(e) > timeOf(best)) best = e;
  }
  return best ? { verdict: best.verdict, at: best.verdict.evaluatedAt ?? best.verdict.timestamp ?? best.savedAt } : null;
}
