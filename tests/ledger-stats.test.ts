import { describe, expect, it } from 'vitest';
import { buildUnits, finalAssessmentFrom, isEligible, isoWeek, ledgerStats, PREREG, summarize } from '@/lib/ledger-stats';
import type { OutcomeRow, SignalRow } from '@/lib/ledger';
import type { CostsConfig } from '@/lib/costs';

const costs: CostsConfig = {
  version: 1,
  assumedTradeSizeDkk: 20000,
  brokerage: { US: { minDkk: 0, pct: 0.1 } }, // round-trip = 2 × 0,1 + 2 × 0,25 + 0,3 = 1,0 %
  fxSpreadPctByCurrency: { USD: 0.25 },
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

const outcome = (signalId: string, horizon: number, abnormalDkk: number, entryDate = '2026-11-05', abnormalIwmDkk: number | null = null): OutcomeRow =>
  ({ signalId, horizon, entryDate, abnormalDkk, abnormalIwmDkk }) as OutcomeRow;

/**
 * n enheder, 5 pr. uge med scorerne 30/40/50/60/70 (score-effekten går ud inden for ugen). Ugens værdi er
 * `meanNet` ± 1 % skiftevis, så bootstrap-fordelingen er binomial og grænserne kendte:
 * 30 uger → 5 %-percentil ≈ meanNet − 0,27/0,33 %, 1 %-percentil ≈ meanNet − 0,40 %.
 */
function dataset(n: number, meanNet: number, scoreEffect: number) {
  const signals: SignalRow[] = [];
  const outcomes: OutcomeRow[] = [];
  for (let i = 0; i < n; i++) {
    const week = Math.floor(i / 5);
    const d = new Date(Date.UTC(2026, 10, 9 + week * 7)); // mandage fra 9.11.2026
    const entryDate = d.toISOString().slice(0, 10);
    const score = 30 + (i % 5) * 10;
    const net = meanNet + (week % 2 === 0 ? 0.01 : -0.01) + (score - 50) * scoreEffect;
    const id = `s${i}`;
    signals.push(signal(id, { ticker: `T${i}`, gatekeeperScore: score }));
    for (const h of [5, 21]) outcomes.push(outcome(id, h, net + 0.01, entryDate, net + 0.01)); // + 1 % omkostning
  }
  return { signals, outcomes };
}

describe('måling (fase 3, 6) efter prereg v1', () => {
  it('PREREG matcher præregistreringen', () => {
    expect(PREREG.goLiveMinUnits).toBe(150);
    expect([PREREG.interimConfidence, PREREG.finalConfidence]).toEqual([0.99, 0.95]);
    expect([PREREG.primaryBenchmark, PREREG.secondaryBenchmark]).toEqual(['SPY', 'IWM']);
    expect(finalAssessmentFrom().toISOString()).toBe('2027-05-04T21:59:32.062Z');
  });

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

  it('signaler på samme aktie samme entry-dag er én enhed; netto = abnormalt − omkostning, mod SPY og IWM', () => {
    const units = buildUnits(
      [signal('a', { gatekeeperScore: 55 }), signal('b', { gatekeeperScore: 66 })],
      [outcome('a', 5, 0.03, '2026-11-05', 0.02), outcome('b', 5, 0.03, '2026-11-05', 0.02)],
      costs
    );
    expect(units).toHaveLength(1);
    expect(units[0].score).toBe(66);
    expect(units[0].net.SPY[5]).toBeCloseTo(0.03 - 0.01, 12);
    expect(units[0].net.IWM[5]).toBeCloseTo(0.02 - 0.01, 12);
  });

  it('ukendt marked → ingen nettotal (intet gæt); manglende IWM → kun SPY', () => {
    expect(buildUnits([signal('a', { currency: 'SEK' })], [outcome('a', 5, 0.03)], costs)).toHaveLength(0);
    expect(buildUnits([signal('a')], [outcome('a', 5, 0.03)], costs)[0].net.IWM[5]).toBeUndefined();
  });

  it('bootstrap er deterministisk (fast seed), klynger på uge, og 99 %-grænsen ligger under 95 %', () => {
    const pts = Array.from({ length: 40 }, (_, i) => ({ week: `2026-U${10 + (i % 8)}`, value: ((i % 5) - 1) / 100 }));
    const a = summarize(pts, 2000);
    expect(a).toEqual(summarize(pts, 2000));
    expect(a.ciLow! <= a.mean! && a.mean! <= a.ciHigh!).toBe(true);
    expect(a.lowerOneSided99!).toBeLessThanOrEqual(a.lowerOneSided95!);
    expect(summarize([{ week: 'w', value: 1 }]).ciLow).toBeNull(); // én uge → intet interval
  });

  it('H1 er hele populationen; score ≥ 50 er sekundær', () => {
    const s = ledgerStats({
      signals: [signal('a', { gatekeeperScore: 20, ticker: 'A' }), signal('b', { gatekeeperScore: 60, ticker: 'B' })],
      outcomes: [outcome('a', 5, 0.05), outcome('b', 5, 0.03)],
      costs,
      now: new Date('2026-11-20T12:00:00Z'),
      resamples: 200,
    });
    expect(s.primary.SPY.n).toBe(2);
    expect(s.aboveThreshold.n).toBe(1);
    expect(s.totals.eligibleAboveThreshold).toBe(1);
  });

  it('go-live: 150 enheder; interim kræver ensidet 99 %, endelig 95 %', () => {
    const { signals, outcomes } = dataset(150, 0.0036, 0.00001);
    const interim = ledgerStats({ signals, outcomes, costs, now: new Date('2027-02-01T12:00:00Z') });
    const final = ledgerStats({ signals, outcomes, costs, now: new Date('2027-06-01T12:00:00Z') });
    expect([interim.goLive.phase, interim.goLive.confidence, final.goLive.phase, final.goLive.confidence]).toEqual(['interim', 0.99, 'endelig', 0.95]);
    expect(interim.goLive.units).toBe(150);
    expect(interim.goLive.sanityTopAboveBottom).toBe(true);
    // Samme data: den nedre 95 %-grænse er over 0, den nedre 99 %-grænse er ikke.
    expect(final.goLive.lowerBound!).toBeGreaterThan(0);
    expect(interim.goLive.lowerBound!).toBeLessThanOrEqual(0);
    expect([interim.goLive.met, final.goLive.met]).toEqual([false, true]);
  });

  it('go-live: 149 enheder er for få; sanity-tjekket vises, men blokerer ikke porten (basisstrategien bedømmes)', () => {
    const few = dataset(149, 0.02, 0.00001);
    expect(ledgerStats({ ...few, costs, now: new Date('2027-06-01T12:00:00Z'), resamples: 500 }).goLive.met).toBe(false);
    const inverted = dataset(150, 0.02, -0.0001); // højere score → lavere afkast
    const s = ledgerStats({ ...inverted, costs, now: new Date('2027-06-01T12:00:00Z'), resamples: 500 });
    expect(s.goLive.lowerBound!).toBeGreaterThan(0);
    expect(s.goLive.sanityTopAboveBottom).toBe(false);
    expect(s.goLive.met).toBe(true);
  });

  it('bruttoafkast (før omkostninger) er en sekundær metrik pr. horisont', () => {
    const s = ledgerStats({
      signals: [signal('a', { ticker: 'A' }), signal('b', { ticker: 'B' })],
      outcomes: [outcome('a', 5, 0.03), outcome('b', 5, 0.01)],
      costs,
      now: new Date('2026-11-20T12:00:00Z'),
      resamples: 200,
    });
    expect(s.gross['5'].mean).toBeCloseTo(0.02, 12);
    expect(s.primary.SPY.mean).toBeCloseTo(0.02 - 0.01, 12); // netto = brutto − 1 % round-trip
    expect(s.gross['21'].n).toBe(0);
  });

  it('"mangler udfald" tæller signaler med nået horisont uden række', () => {
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
  });
});
