import { describe, expect, it } from 'vitest';
import { generateTradeExecutionPlan } from '@/lib/trade-planner';
import { verifyDkTradability } from '@/lib/market-enricher';
import { convertCurrency, currencyForTicker, getFxRateToDkk, type LiveFxRates } from '@/lib/live-quote';
import type { CouncilVerdict, InsiderTransaction } from '@/types/insider';

const tx = (over: Partial<InsiderTransaction> = {}) =>
  ({ id: 't1', ticker: 'ACN', companyName: 'Accenture plc', pricePerShare: 250, ...over }) as InsiderTransaction;
const verdict = { asymmetryScore: 85, verdict: 'STRONG ASYMMETRY (KØB)' } as CouncilVerdict;
const q = (rate: number) => ({ rate, fetchedAt: '2026-11-04T12:00:00Z' });
const fx: LiveFxRates = { USD_DKK: q(6.65), EUR_DKK: q(7.46), SEK_DKK: q(0.68), NOK_DKK: q(0.62), fxIsLive: true, lastUpdated: '' };

describe('trade-planner uden opfundne tal', () => {
  it('uden ATR → DO_NOT_TRADE "Data mangler"', () => {
    const plan = generateTradeExecutionPlan(tx({ currentMarketPrice: 260 }), verdict, 25000, fx);
    expect(plan.status).toBe('DO_NOT_TRADE');
    expect(plan.reason).toMatch(/Data mangler.*ATR14/);
  });

  it('uden live-kurs → DO_NOT_TRADE, selvom insiderkursen findes', () => {
    const plan = generateTradeExecutionPlan(tx({ atr14d: 5 }), verdict, 25000, fx);
    expect(plan.status).toBe('DO_NOT_TRADE');
    expect(plan.reason).toMatch(/Data mangler.*live-kurs/);
  });

  it('med kurs og ATR → ACTIVE_PLAN', () => {
    const plan = generateTradeExecutionPlan(tx({ currentMarketPrice: 260, atr14d: 5 }), verdict, 25000, fx);
    expect(plan.status).toBe('ACTIVE_PLAN');
    expect(plan.stopLossPrice).toBeGreaterThan(0);
  });

  it('uden live FX → DO_NOT_TRADE "Live valutakurs mangler"', () => {
    const full = tx({ currentMarketPrice: 260, atr14d: 5 });
    expect(generateTradeExecutionPlan(full, verdict, 25000, null).reason).toMatch(/Live valutakurs mangler/);
    const noUsd = { ...fx, USD_DKK: undefined, fxIsLive: false };
    expect(generateTradeExecutionPlan(full, verdict, 25000, noUsd).status).toBe('DO_NOT_TRADE');
  });

  it('.OL prissættes i NOK og .HE i EUR (ikke USD-kursen)', () => {
    const ol = generateTradeExecutionPlan(tx({ ticker: 'EQNR.OL', currentMarketPrice: 300, atr14d: 6 }), verdict, 25000, fx);
    // 25.000 DKK ved 300 NOK × 0,62 = 186 DKK/aktie → 134 aktier (med USD-kursen ville det være ca. 12)
    expect(ol.totalShares).toBe(Math.floor(25000 / (300 * 0.62)));
    expect(ol.tranche1.description).toMatch(/NOK 300/);
    const he = generateTradeExecutionPlan(tx({ ticker: 'NOKIA.HE', currentMarketPrice: 5, atr14d: 0.1 }), verdict, 25000, fx);
    expect(he.totalShares).toBe(Math.floor(25000 / (5 * 7.46)));
  });
});

describe('FX-service', () => {
  it('currencyForTicker ud fra suffiks', () => {
    expect([currencyForTicker('NOVO-B.CO'), currencyForTicker('VOLV-B.ST'), currencyForTicker('NOKIA.HE'), currencyForTicker('EQNR.OL'), currencyForTicker('ACN')]).toEqual(['DKK', 'SEK', 'EUR', 'NOK', 'USD']);
  });

  it('manglende eller ukendt kurs → undefined, aldrig USD-kursen som stand-in', () => {
    expect(getFxRateToDkk('GBP', fx)).toBeUndefined();
    expect(getFxRateToDkk(undefined, fx)).toBeUndefined();
    expect(getFxRateToDkk('SEK', { ...fx, SEK_DKK: undefined })).toBeUndefined();
    expect(getFxRateToDkk('DKK', null)).toBe(1);
    expect(convertCurrency(100, 'DKK', 'USD', null)).toBeUndefined();
    expect(convertCurrency(665, 'DKK', 'USD', fx)).toBeCloseTo(100, 6);
  });
});

describe('verifyDkTradability', () => {
  it('manglende metadata → undefined, aldrig "Verificeret" (insiderkurs bruges ikke som markedskurs)', () => {
    const r = verifyDkTradability(tx());
    expect(r.isTradableInDK).toBeUndefined();
    expect(r.tradabilityReason).toMatch(/^Ikke verificeret – data mangler/);
  });

  it('OTC og børser uden for listen → false', () => {
    expect(verifyDkTradability(tx(), { exchangeName: 'PNK', fullExchangeName: 'OTC Markets' }).isTradableInDK).toBe(false);
    expect(verifyDkTradability(tx(), { exchangeName: 'LSE', fullExchangeName: 'London' }).isTradableInDK).toBe(false);
  });

  it('fuld data på en godkendt børs → true og "Verificeret"', () => {
    const r = verifyDkTradability(tx(), {
      exchangeName: 'NYQ',
      fullExchangeName: 'NYSE',
      instrumentType: 'EQUITY',
      currency: 'USD',
      currentPrice: 260,
      avgDailyDollarVolume: 500_000_000,
    });
    expect(r.isTradableInDK).toBe(true);
    expect(r.exchange).toBe('NYSE');
    expect(r.tradabilityReason).toMatch(/^Verificeret: NYSE/);
  });
});
