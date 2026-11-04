import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeLedger, listOutcomes, recordSignals } from '@/lib/ledger';
import { computeMissingOutcomes, computeOutcome, toSeries, type BarSeries } from '@/lib/outcomes';
import type { InsiderTransaction } from '@/types/insider';

// Rigtige Yahoo-dagsdata 19.11–5.12.2025 (hentet 4.11.2026): SPY lukket torsdag 27.11 (Thanksgiving),
// København åben samme dag; weekender mangler i alle serier.
type Raw = { symbol: string; tz: string; timestamp: number[]; open: Array<number | null>; close: Array<number | null> };
const raw: Record<string, Raw> = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'yahoo-daily-2025-11.json'), 'utf-8'));
const series = (sym: string): BarSeries => toSeries(sym, raw[sym].tz, raw[sym].timestamp, raw[sym].open, raw[sym].close);
const spy = series('SPY');
const novo = series('NOVO-B.CO');
const usdDkk = series('USDDKK=X');
const NOW = new Date('2025-12-06T12:00:00Z');

const sig = (detectedAt: string, currency = 'USD') => ({ id: 's1', currency, detectedAt, scoredAt: null });

describe('udfald: entry-dag (fase 3, 4 og 8)', () => {
  it('fredag efter lukketid → entry mandag åbning (weekend)', () => {
    const r = computeOutcome({ signal: sig('2025-11-21T21:30:00Z'), horizon: 1, stock: spy, spy, fx: usdDkk, usdDkk, now: NOW });
    expect(r.status).toBe('beregnet');
    if (r.status !== 'beregnet') return;
    expect([r.row.entryDate, r.row.entryPrice, r.row.exitDate, r.row.exitPrice]).toEqual(['2025-11-24', 662.69, '2025-11-24', 668.73]);
    expect(r.row.abnormalLocal).toBeCloseTo(0, 12); // aktien er SPY selv
    expect(r.row.abnormalDkk).toBeCloseTo(0, 12);
  });

  it('onsdag aften før Thanksgiving → entry fredag; 5 handelsdage springer helligdag og weekend over', () => {
    const r = computeOutcome({ signal: sig('2025-11-26T22:00:00Z'), horizon: 5, stock: spy, spy, fx: usdDkk, usdDkk, now: NOW });
    expect(r.status).toBe('beregnet');
    if (r.status !== 'beregnet') return;
    expect([r.row.entryDate, r.row.exitDate]).toEqual(['2025-11-28', '2025-12-04']);
    // USD → DKK med USDDKK-close på entry- og exit-datoen
    expect(r.row.retDkk).toBeCloseTo((684.39 * 6.4008) / (680.86 * 6.4381) - 1, 10);
    expect([r.row.fxEntry, r.row.fxExit]).toEqual([6.4381, 6.4008]);
  });

  it('nordisk aktie i DKK: ingen FX; SPY lukket i hele vinduet → SPY-afkast 0', () => {
    const r = computeOutcome({ signal: sig('2025-11-26T17:00:00Z', 'DKK'), horizon: 1, stock: novo, spy, fx: null, usdDkk, now: NOW });
    expect(r.status).toBe('beregnet');
    if (r.status !== 'beregnet') return;
    expect([r.row.entryDate, r.row.entryPrice, r.row.exitPrice]).toEqual(['2025-11-27', 310, 310.9]);
    expect(r.row.retDkk).toBeCloseTo(r.row.retLocal, 12);
    expect(r.row.spyRetUsd).toBe(0);
    expect(r.row.abnormalLocal).toBeNull(); // kun meningsfuld for USD-aktier
    expect(r.row.abnormalDkk).toBeCloseTo(310.9 / 310 - 1, 10);
  });

  it('horisont ikke nået, og en ufærdig SPY-dag (NY bag CPH) venter', () => {
    expect(
      computeOutcome({ signal: sig('2025-11-21T21:30:00Z'), horizon: 5, stock: spy, spy, fx: usdDkk, usdDkk, now: new Date('2025-11-25T12:00:00Z') }).status
    ).toBe('ikke-nået');
    // CPH 28.11 kl. 01:30 = NY 27.11 kl. 19:30 → exit-datoen 27.11 er ikke afsluttet i alle serier endnu
    expect(
      computeOutcome({ signal: sig('2025-11-26T17:00:00Z', 'DKK'), horizon: 1, stock: novo, spy, fx: null, usdDkk, now: new Date('2025-11-28T00:30:00Z') }).status
    ).toBe('ikke-nået');
  });

  it('manglende kurs giver ingen række (aldrig 0)', () => {
    const holey: BarSeries = { ...spy, bars: spy.bars.map((b) => (b.date === '2025-11-24' ? { ...b, open: null } : b)) };
    const r = computeOutcome({ signal: sig('2025-11-21T21:30:00Z'), horizon: 1, stock: holey, spy, fx: usdDkk, usdDkk, now: NOW });
    expect(r).toEqual({ status: 'mangler-data', reason: 'åbningskurs mangler 2025-11-24' });
  });

  it('en senere score flytter ankeret, så scoren aldrig ser kurser efter entry', () => {
    const r = computeOutcome({
      signal: { id: 's1', currency: 'USD', detectedAt: '2025-11-21T21:30:00Z', scoredAt: '2025-11-24T22:00:00Z' },
      horizon: 1, stock: spy, spy, fx: usdDkk, usdDkk, now: NOW,
    });
    expect(r.status === 'beregnet' && r.row.entryDate).toBe('2025-11-25');
  });
});

describe('udfaldsjob mod ledgeren', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insiderops-outcomes-'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });
  afterEach(() => {
    closeLedger();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const tx = (o: Partial<InsiderTransaction>) =>
    ({ id: 'oi-1-1', accessionNo: '1', ownerCik: '1', ticker: 'SPY', insiderName: 'A', currency: 'USD', transactionCode: 'P', shares: 1, pricePerShare: 1, totalValueUsd: 1, isClusterBuy: false, secFilingUrl: '', companyName: '', insiderTitle: '', ...o }) as InsiderTransaction;

  it('beregner nåede horisonter, gemmer ikke manglende kurs, og overskriver aldrig', async () => {
    recordSignals({ passed: [tx({}), tx({ id: 'oi-2-2', accessionNo: '2', ownerCik: '2', ticker: 'GONE' })], items: [], scanSource: 'unified', detectedAt: '2025-11-21T21:30:00Z', fx: null });
    const fetcher = async (sym: string) => {
      if (sym === 'GONE') throw new Error('Yahoo GONE svarede 404');
      return series(sym);
    };
    const first = await computeMissingOutcomes({ now: NOW, fetcher });
    expect(first.inserted).toBe(2); // SPY: 1 og 5 dage; 21/63 ikke nået
    expect(first.notReached).toBe(2);
    expect(first.fetchErrors).toEqual([{ symbol: 'GONE', error: 'Yahoo GONE svarede 404' }]);
    expect(first.missingData.filter((m) => m.signalId === 'acc:2:2')).toHaveLength(4);
    expect(listOutcomes().every((o) => o.signalId === 'acc:1:1')).toBe(true);

    const again = await computeMissingOutcomes({ now: NOW, fetcher });
    expect(again.inserted).toBe(0);
    expect(listOutcomes()).toHaveLength(2);
  });
});
