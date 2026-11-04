import { describe, expect, it } from 'vitest';
import {
  buildTrackRecord,
  classifyReputation,
  HORIZON_TRADING_DAYS,
  isSamePerson,
  measureAtHorizon,
  type PastBuy,
  type PriceHistory,
} from '@/lib/track-record';
import type { InsiderTransaction } from '@/types/insider';

/** Handelsdage fra startdato; kurs = fn(index). */
function history(start: string, days: number, price: (i: number) => number): PriceHistory {
  const dates: string[] = [];
  const closes: number[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    dates.push(d.toISOString().slice(0, 10));
    closes.push(price(i));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return { dates, closes };
}
const buy = (date: string, name = 'Doe John', price = 10): PastBuy => ({ date, insiderName: name, price, valueUsd: 100_000 });

describe('track record med fast horisont (audit P2 / fase 2, 4b)', () => {
  it('måler over 126 handelsdage, ikke til dagens kurs', () => {
    // Kursen stiger 1 pr. dag: efter 126 dage fra 10 → 136; dagens kurs (sidste punkt) er langt højere.
    const h = history('2024-01-01', 600, (i) => 10 + i);
    const { measured } = measureAtHorizon([buy('2024-01-01')], h);
    expect(measured[0].returnPct).toBeCloseTo(((10 + HORIZON_TRADING_DAYS - 10) / 10) * 100, 1);
  });

  it('køb yngre end horisonten udelades', () => {
    const h = history('2026-01-01', 200, () => 10);
    const { measured, unmeasured } = measureAtHorizon([buy('2026-01-02'), buy('2026-06-01')], h);
    expect(measured).toHaveLength(1);
    expect(unmeasured.map((b) => b.date)).toEqual(['2026-06-01']);
  });

  it('APLD-lignende kursløb: 31 køb giver ikke +594 %, når de måles over horisonten', () => {
    // Flad kurs i 2 år, så et kæmpe løb de sidste 120 dage. Gamle køb måles før løbet.
    const h = history('2023-01-01', 1400, (i) => (i < 1280 ? 5 : 5 + (i - 1280) * 0.3));
    const buys = Array.from({ length: 31 }, (_, k) => buy(new Date(Date.UTC(2023, 0, 1 + k * 30)).toISOString().slice(0, 10)));
    const tx = { ticker: 'APLD', insiderName: 'Someone Else', tradeDate: '2026-10-19' } as InsiderTransaction;
    const tr = buildTrackRecord(tx, buys, h);
    expect(tr.avgReturnPct).toBeLessThan(100);
    expect(tr.historicalBuysCount + (tr.unmeasuredBuysCount ?? 0)).toBe(31);
  });

  it('SMART_MONEY_SNIPER kræver mindst 3 målte køb', () => {
    const m = (r: number) => ({ ...buy('2025-01-01'), returnPct: r });
    expect(classifyReputation([m(50), m(40)], [buy('2025-01-01'), buy('2025-02-01')], '2026-10-01').reputation).toBe('CREDIBLE_BUYER');
    expect(classifyReputation([m(50), m(40), m(30)], [buy('2025-01-01')], '2026-10-01').reputation).toBe('SMART_MONEY_SNIPER');
  });

  it('FIRST_TIME_OR_RARE = ingen køb i 24 måneder; køb uden målinger = UNKNOWN', () => {
    expect(classifyReputation([], [buy('2023-06-01')], '2026-10-01').reputation).toBe('FIRST_TIME_OR_RARE');
    expect(classifyReputation([], [], '2026-10-01').reputation).toBe('FIRST_TIME_OR_RARE');
    expect(classifyReputation([], [buy('2026-08-01')], '2026-10-01').reputation).toBe('UNKNOWN');
  });

  it('insiderens egen historik holdes adskilt fra selskabets', () => {
    const h = history('2023-01-01', 1000, (i) => 10 + i * 0.01);
    const tx = { ticker: 'X', insiderName: 'Doe John A', tradeDate: '2026-01-01' } as InsiderTransaction;
    const tr = buildTrackRecord(tx, [buy('2023-02-01', 'Doe John'), buy('2023-03-01', 'Roe Rick'), buy('2023-04-01', 'Roe Rick')], h);
    expect(tr.historicalBuysCount).toBe(3);
    expect(tr.insiderOnly?.historicalBuysCount).toBe(1);
    expect(isSamePerson('Doe John', 'DOE JOHN A')).toBe(true);
    expect(isSamePerson('Rasmussen Lars', 'Rasmussen Lene')).toBe(false);
  });
});
