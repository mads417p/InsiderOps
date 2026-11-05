import { describe, expect, it } from 'vitest';
import { closePosition, computeAlphaDkk, computeRealKpis, computeSummary, mergeExitWarning, refreshPosition } from '@/lib/portfolio';
import { loadCosts } from '@/lib/costs';
import { closeOnOrBefore, needsBackfill } from '../scripts/backfill-benchmark';
import type { LiveFxRates } from '@/lib/live-quote';
import type { PaperTradePosition } from '@/types/insider';

const q = (rate: number) => ({ rate, fetchedAt: '' });
const fx = (usd: number): LiveFxRates => ({ USD_DKK: q(usd), EUR_DKK: q(7.46), SEK_DKK: q(0.68), NOK_DKK: q(0.62), fxIsLive: true, lastUpdated: '' });

const pos = (over: Partial<PaperTradePosition> = {}): PaperTradePosition =>
  ({
    id: 'p1',
    ticker: 'ACN',
    status: 'OPEN',
    tradeType: 'PAPER',
    shares: 10,
    entryPrice: 100,
    entryFxRateDkk: 7,
    entryUsdDkk: 7,
    currentPrice: 100,
    currentFxRateDkk: 7,
    insiderBuyPrice: 95,
    investedDkk: 7000,
    pnlDkk: 0,
    pnlPct: 0,
    stopLossPrice: 80,
    targetPrice: 150,
    benchmarkEntryPrice: 500,
    openedAt: '2026-11-01T12:00:00Z',
    ...over,
  }) as PaperTradePosition;

describe('alpha i DKK (audit 1.8)', () => {
  it('US-position: begge sider i DKK – en dollar-styrkelse løfter både aktie og SPY', () => {
    // Aktien +10 % i USD, SPY +10 % i USD, USD/DKK 7 → 7,7: begge +21 % i DKK → alpha 0.
    const r = computeAlphaDkk({ entryPrice: 100, entryFx: 7, price: 110, fxNow: 7.7, spyEntry: 500, usdDkkEntry: 7, spyNow: 550, usdDkkNow: 7.7 });
    expect(r.positionReturnPct).toBeCloseTo(21, 6);
    expect(r.benchmarkReturnPct).toBeCloseTo(21, 6);
    expect(r.alphaPct).toBeCloseTo(0, 6);
  });

  it('DKK-position: aktien i DKK mod SPY i DKK (før: aktiens lokale afkast minus SPY i USD)', () => {
    // Novo +5 % i DKK; SPY uændret i USD, men USD/DKK 7 → 6,3 (−10 %) → SPY −10 % i DKK → alpha +15.
    const r = computeAlphaDkk({ entryPrice: 400, entryFx: 1, price: 420, fxNow: 1, spyEntry: 500, usdDkkEntry: 7, spyNow: 500, usdDkkNow: 6.3 });
    expect(r.alphaPct).toBeCloseTo(15, 6);
  });

  it('manglende SPY ved entry giver null ("N/A"), aldrig 755-fallback', () => {
    expect(computeAlphaDkk({ entryPrice: 100, entryFx: 7, price: 110, fxNow: 7, spyNow: 550, usdDkkEntry: 7, usdDkkNow: 7 }).alphaPct).toBeNull();
    const p = refreshPosition(pos({ benchmarkEntryPrice: undefined }), { quote: { price: 110, currency: 'USD' }, fx: fx(7), spyPrice: 550 });
    expect(p.alphaPct).toBeNull();
    expect(p.pnlDkk).toBe(700);
  });
});

describe('stop/target og lukning (audit 1.9)', () => {
  it('PAPER: stop lukker med exit-felter og realiseret P&L; positionen bevares', () => {
    const p = refreshPosition(pos(), { quote: { price: 79, currency: 'USD' }, fx: fx(7), spyPrice: 500 });
    expect(p.status).toBe('STOPPED_OUT');
    expect(p).toMatchObject({ exitPrice: 79, exitFx: 7, realizedPnlDkk: Math.round(10 * (79 * 7 - 100 * 7)) });
    expect(p.closedAt).toBeTruthy();
  });

  it('REAL_NORDNET får aldrig automatisk ny status – kun en advarsel', () => {
    const p = refreshPosition(pos({ tradeType: 'REAL_NORDNET' }), { quote: { price: 79, currency: 'USD' }, fx: fx(7), spyPrice: 500 });
    expect(p.status).toBe('OPEN');
    expect(p.priceAlert).toBe('STOP');
    expect(p.exitPrice).toBeUndefined();
  });

  it('uden live FX opdateres positionen ikke', () => {
    const before = pos();
    expect(refreshPosition(before, { quote: { price: 120, currency: 'USD' }, fx: null, spyPrice: 500 })).toBe(before);
  });

  it('manuel lukning: CLOSED_MANUAL med realiseret P&L', () => {
    const c = closePosition(pos(), 120, 7.1, 'CLOSED_MANUAL', '2026-11-04T10:00:00Z');
    expect(c).toMatchObject({ status: 'CLOSED_MANUAL', exitPrice: 120, exitFx: 7.1, closedAt: '2026-11-04T10:00:00Z', realizedPnlDkk: 1520 });
  });
});

describe('computeSummary pr. type (audit 1.9)', () => {
  const positions = [
    pos({ id: 'a', investedDkk: 7000, pnlDkk: 700, alphaPct: 5, benchmarkReturnPct: 2 }),
    pos({ id: 'b', tradeType: 'REAL_NORDNET', investedDkk: 50_000, pnlDkk: -5000, alphaPct: -10, benchmarkReturnPct: 2 }),
    pos({ id: 'c', status: 'CLOSED_MANUAL', investedDkk: 7000, realizedPnlDkk: 1000 }),
    pos({ id: 'd', status: 'STOPPED_OUT', investedDkk: 7000, realizedPnlDkk: -500 }),
  ];

  it('PAPER og REAL_NORDNET blandes ikke', () => {
    const paper = computeSummary(positions, 'PAPER');
    const real = computeSummary(positions, 'REAL_NORDNET');
    expect(paper.totalInvestedDkk).toBe(7000);
    expect(paper.unrealizedPnlDkk).toBe(700);
    expect(paper.realizedPnlDkk).toBe(500);
    expect(paper.avgAlphaPct).toBe(5);
    expect(real.totalInvestedDkk).toBe(50_000);
    expect(real.avgAlphaPct).toBe(-10);
  });

  it('win rate tæller kun lukkede positioner; ingen lukkede → null', () => {
    expect(computeSummary(positions, 'PAPER').winRatePct).toBe(50);
    expect(computeSummary(positions, 'REAL_NORDNET').winRatePct).toBeNull();
  });
});

describe('egne KPI-tal for REAL_NORDNET (fase 9)', () => {
  const costs = loadCosts(); // US: 25 kr. min / 0,15 %, USD-FX 0 %; DKK: 25 kr. / 0,1 %
  const real = (over: Partial<PaperTradePosition>) => pos({ tradeType: 'REAL_NORDNET', ...over });
  const positions = [
    // åben US: køb 7.000 kr. → 25 kr. (min); alpha 4 %
    real({ id: 'r1', pnlDkk: 500, alphaPct: 4 }),
    // lukket US: køb 7.000 → 25 kr., salg 10 × 120 × 7,1 = 8.520 → 25 kr.; alpha −2 %
    real({ id: 'r2', status: 'CLOSED_MANUAL', exitPrice: 120, exitFx: 7.1, realizedPnlDkk: 1520, alphaPct: -2 }),
    // lukket DKK-aktie: køb 40.000 kr. → 40 kr., salg 38.000 kr. → 38 kr. (0,1 %); ingen alpha
    real({ id: 'r3', ticker: 'NOVO-B.CO', status: 'CLOSED_MANUAL', shares: 100, entryPrice: 400, entryFxRateDkk: 1, investedDkk: 40000, exitPrice: 380, exitFx: 1, realizedPnlDkk: -2000 }),
    pos({ id: 'paper', pnlDkk: 9999, alphaPct: 50 }), // PAPER tæller ikke
  ];

  it('afkast, omkostninger, antal og alpha over åbne + lukkede', () => {
    const k = computeRealKpis(positions, costs);
    expect(k).toMatchObject({ openCount: 1, closedCount: 2, investedDkk: 54000, grossPnlDkk: 20, costsDkk: 153, costsMissing: 0 });
    expect(k.netPnlDkk).toBe(20 - 153);
    expect(k.netPnlPct).toBeCloseTo((-133 / 54000) * 100, 2);
    expect(k.alphaPct).toBe(1); // (4 × 7.000 − 2 × 7.000) / 14.000
    expect(k.alphaCount).toBe(2);
  });

  it('ingen rigtige handler → nuller og null, intet opfundet', () => {
    expect(computeRealKpis([pos()], costs)).toMatchObject({ openCount: 0, closedCount: 0, costsDkk: 0, netPnlPct: null, alphaPct: null });
  });

  it('lukket uden exit-kurs tælles som manglende omkostning, ikke som 0 kr.', () => {
    const k = computeRealKpis([real({ status: 'CLOSED_MANUAL', realizedPnlDkk: 0 })], costs);
    expect(k.costsMissing).toBe(1);
    expect(k.costsDkk).toBe(0);
  });

  it('lukning med SPY sætter alpha på lukketidspunktet; uden SPY beholdes den gamle', () => {
    // aktie 100 → 110 (+10 %), SPY 500 → 525 (+5 %), samme USD/DKK → alpha 5
    const withSpy = closePosition(pos({ alphaPct: 99 }), 110, 7, 'CLOSED_MANUAL', 'x', { spyNow: 525, usdDkkNow: 7 });
    expect(withSpy).toMatchObject({ alphaPct: 5, benchmarkReturnPct: 5, benchmarkCurrentPrice: 525 });
    expect(closePosition(pos({ alphaPct: 99 }), 110, 7, 'CLOSED_MANUAL', 'x').alphaPct).toBe(99);
  });
});

describe('exit-radar og backfill', () => {
  it('første alarm bevares permanent, selvom næste tjek ikke ser salget', () => {
    const first = { status: 'SALES_FOUND' as const, hasExit: true, firstAlertAt: '2026-11-02T10:00:00Z', firstAlert: { name: 'Doe John', title: 'CFO', date: '2026-11-01', valueUsd: 500_000, kind: 'DISCRETIONARY' as const } };
    const merged = mergeExitWarning(first, { status: 'NO_SALES', hasExit: false, message: '0 salg' });
    expect(merged.hasExit).toBe(true);
    expect(merged.status).toBe('NO_SALES');
    expect(merged.firstAlert?.name).toBe('Doe John');
  });

  it('backfill: 755-reserven og manglende felter erstattes; lukkekurs på eller før dato', () => {
    expect(needsBackfill(pos({ benchmarkEntryPrice: 755 })).spy).toBe(true);
    expect(needsBackfill(pos({ benchmarkEntryPrice: 755.72 })).spy).toBe(false);
    expect(needsBackfill(pos({ entryUsdDkk: undefined })).usdDkk).toBe(true);
    expect(closeOnOrBefore(['2026-10-29', '2026-10-30', '2026-11-02'], [750, 755.72, 760], '2026-11-01')).toBe(755.72);
  });
});
