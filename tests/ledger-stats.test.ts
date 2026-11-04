import { describe, expect, it } from 'vitest';
import { buildUnits, isEligible, isoWeek, ledgerStats, summarize } from '@/lib/ledger-stats';
import type { OutcomeRow, SignalRow } from '@/lib/ledger';
import type { CostsConfig } from '@/lib/costs';

const costs: CostsConfig = {
  version: 1,
  assumedTradeSizeDkk: 20000,
  brokerage: { US: { minDkk: 0, pct: 0.1 } }, // round-trip = 2 × 0,1 + 2 × 0,25 + 0,3 = 1,0 %
  fxSpreadPct: 0.25,
  roundTripSpreadSlippagePctByLiquidity: [{ minAvgDailyUsd: 0, pct: 0.3 }],
};

const signal = (id: string, o: Partial<SignalRow> = {}): SignalRow => ({
  id,
  detectedAt: '2026-11-04T21:00:00.000Z',
  lastSeenAt: '2026-11-04T21:00:00.000Z',
  source: 'SEC Form 4',
  scanSource: 'unified',
  ticker: 'AAA',
  currency: 'USD',
  filedAtUtc: '2026-11-04T00:00:00.000Z',
  tradeDate: '2026-11-02',
  insiderName: 'X',
  is10b51: 0,
  gatekeeperScore: 60,
  scoreSource: 'claude',
  scoredAt: '2026-11-04T21:00:00.000Z',
  featuresJson: '{"avgDailyDollarVolume":1e8}',
  ...o,
});

const outcome = (signalId: string, horizon: number, abnormalDkk: number, entryDate = '2026-11-05'): OutcomeRow =>
  ({ signalId, horizon, entryDate, abnormalDkk }) as OutcomeRow;

describe('måling (fase 3, 6)', () => {
  it('ISO-uge', () => {
    expect(isoWeek('2026-11-04')).toBe('2026-U45');
    expect(isoWeek('2027-01-01')).toBe('2026-U53'); // fredag hører til 2026's sidste uge
    expect(isoWeek('2026-12-28')).toBe('2026-U53');
  });

  it('population: kun Claude-score, frisk (≤ 72 t) og ikke 10b5-1', () => {
    expect(isEligible(signal('a'))).toBe(true);
    expect(isEligible(signal('b', { scoreSource: 'gemini' }))).toBe(false);
    expect(isEligible(signal('c', { is10b51: 1 }))).toBe(false);
    expect(isEligible(signal('d', { filedAtUtc: '2026-10-01T00:00:00.000Z' }))).toBe(false); // ticker-scan af gammel handel
    expect(isEligible(signal('e', { filedAtUtc: null }))).toBe(false);
  });

  it('signaler på samme aktie samme entry-dag er én enhed; netto = abnormalt − omkostning', () => {
    const units = buildUnits(
      [signal('a', { gatekeeperScore: 55 }), signal('b', { gatekeeperScore: 66 })],
      [outcome('a', 5, 0.03), outcome('b', 5, 0.03)],
      costs
    );
    expect(units).toHaveLength(1);
    expect(units[0].score).toBe(66);
    expect(units[0].net[5]).toBeCloseTo(0.03 - 0.01, 12);
  });

  it('ukendt marked → ingen nettotal (intet gæt)', () => {
    expect(buildUnits([signal('a', { currency: 'SEK' })], [outcome('a', 5, 0.03)], costs)).toHaveLength(0);
  });

  it('bootstrap er deterministisk (fast seed) og klynger på uge', () => {
    const pts = Array.from({ length: 40 }, (_, i) => ({ week: `2026-U${10 + (i % 8)}`, value: ((i % 5) - 1) / 100 }));
    const a = summarize(pts, 2000);
    const b = summarize(pts, 2000);
    expect(a).toEqual(b);
    expect(a.ciLow! <= a.mean! && a.mean! <= a.ciHigh!).toBe(true);
    expect(a.lowerOneSided95!).toBeGreaterThanOrEqual(a.ciLow!);
    expect(summarize([{ week: 'w', value: 1 }]).ciLow).toBeNull(); // én uge → intet interval
  });

  it('go-live er ikke opfyldt med få enheder, og "mangler udfald" tæller signaler med nået horisont uden række', () => {
    const s = ledgerStats({
      signals: [signal('a'), signal('b', { ticker: 'BBB', detectedAt: '2026-10-01T21:00:00.000Z', scoredAt: null })],
      outcomes: [outcome('a', 5, 0.05)],
      costs,
      now: new Date('2026-11-20T12:00:00Z'),
      resamples: 200,
    });
    expect(s.goLive.met).toBe(false);
    expect(s.goLive.units).toBe(0); // intet 21-dages udfald endnu
    expect(s.totals.missingOutcomes).toBe(2); // a mangler 1 d (21 d er ikke nået); b mangler 1, 5 og 21 d
    expect(s.primary.n).toBe(1);
  });
});
