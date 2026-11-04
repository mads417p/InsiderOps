import { describe, expect, it } from 'vitest';
import { latestValidatedVerdict } from '@/lib/verdicts';
import { closePosition, refreshPosition } from '@/lib/portfolio';
import { portfolioPatchSchema } from '@/lib/api-schemas';
import { needsOpenedScore } from '../scripts/backfill-opened-score';
import type { CouncilVerdict, PaperTradePosition } from '@/types/insider';
import type { LiveFxRates } from '@/lib/live-quote';

const v = (ticker: string, score: number, evaluatedAt: string, validated = true) => ({
  transaction: { ticker },
  verdict: { asymmetryScore: score, verdict: 'MODERATE SIGNAL (OVERVÅG)', evaluatedAt, validated } as CouncilVerdict,
  savedAt: evaluatedAt,
});

describe('nyeste validerede dom pr. ticker (fase 2.5, 2a)', () => {
  it('vælger den nyeste validerede dom og springer ikke-validerede over', () => {
    const verdicts = {
      a: v('DINO', 85, '2026-11-01T10:00:00Z'),
      b: v('DINO', 56, '2026-11-04T20:00:00Z'),
      c: v('DINO', 99, '2026-11-05T09:00:00Z', false), // nyere, men ikke valideret
      d: v('ACN', 80, '2026-11-04T20:00:00Z'),
    };
    const latest = latestValidatedVerdict(verdicts, 'dino');
    expect(latest?.verdict.asymmetryScore).toBe(56);
    expect(latest?.at).toBe('2026-11-04T20:00:00Z');
    expect(latestValidatedVerdict(verdicts, 'RAPP')).toBeNull();
  });
});

describe('openedScore overskrives aldrig (fase 2.5, 2b)', () => {
  const q = (rate: number) => ({ rate, fetchedAt: '' });
  const fx: LiveFxRates = { USD_DKK: q(7), EUR_DKK: q(7.46), SEK_DKK: q(0.68), NOK_DKK: q(0.62), fxIsLive: true, lastUpdated: '' };
  const pos = {
    id: 'p1', ticker: 'DINO', status: 'OPEN', tradeType: 'PAPER', shares: 10, entryPrice: 100, entryFxRateDkk: 7,
    entryUsdDkk: 7, currentPrice: 100, currentFxRateDkk: 7, insiderBuyPrice: 95, investedDkk: 7000, pnlDkk: 0,
    pnlPct: 0, stopLossPrice: 80, targetPrice: 150, benchmarkEntryPrice: 500, openedAt: '2026-11-01T12:00:00Z',
    asymmetryScore: 85, openedScore: 85,
  } as PaperTradePosition;

  it('refresh og lukning bevarer openedScore', () => {
    expect(refreshPosition(pos, { quote: { price: 90, currency: 'USD' }, fx, spyPrice: 500 }).openedScore).toBe(85);
    expect(closePosition(pos, 120, 7.1, 'CLOSED_MANUAL', '2026-11-04T10:00:00Z').openedScore).toBe(85);
  });

  it('PATCH kan ikke sætte openedScore (strict skema)', () => {
    expect(portfolioPatchSchema.safeParse({ id: 'p1', openedScore: 10 }).success).toBe(false);
  });

  it('backfill rammer kun positioner uden openedScore og er idempotent', () => {
    const old = { ...pos, openedScore: undefined };
    expect(needsOpenedScore(old)).toBe(true);
    const after = { ...old, openedScore: old.asymmetryScore };
    expect(needsOpenedScore(after)).toBe(false);
    expect(needsOpenedScore(pos)).toBe(false);
  });
});
