import { describe, expect, it } from 'vitest';
import { generateTradeExecutionPlan } from '@/lib/trade-planner';
import { verifyDkTradability } from '@/lib/market-enricher';
import { convertCurrency, currencyForTicker, getFxRateToDkk, mergeFxRates, type LiveFxRates } from '@/lib/live-quote';
import type { CouncilVerdict, InsiderTransaction } from '@/types/insider';
import { loadCosts } from '@/lib/costs';

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

describe('trade-planner til rigtige handler (fase 9)', () => {
  const costs = loadCosts();
  // 260 USD × 6,65 = 1.729 DKK/aktie; likvid aktie (ADV $500 mio.)
  const liquid = tx({ currentMarketPrice: 260, atr14d: 5, avgDailyDollarVolume: 5e8 });

  it('én ordre som standard; trancher kun som valg', () => {
    const one = generateTradeExecutionPlan(liquid, verdict, 25000, fx, { costs });
    expect(one.tranche2.shares).toBe(0);
    expect(one.tranche1.shares).toBe(one.totalShares);
    expect(one.cost?.orders).toBe(2); // ét køb + ét salg
    const two = generateTradeExecutionPlan(liquid, verdict, 25000, fx, { tranches: true, costs });
    expect(two.tranche2.shares).toBeGreaterThan(0);
    expect(two.cost?.orders).toBe(3);
  });

  it('to trancher koster mere end én ordre, når minimumskurtagen slår igennem', () => {
    const one = generateTradeExecutionPlan(liquid, verdict, 10000, fx, { costs })!.cost!;
    const two = generateTradeExecutionPlan(liquid, verdict, 10000, fx, { tranches: true, costs })!.cost!;
    expect(two.dkk - one.dkk).toBe(25); // én ekstra minimumskurtage
  });

  it('advarer under ca. 16.700 kr. pr. ordre (US: 25 kr. / 0,15 %), ikke over', () => {
    const small = generateTradeExecutionPlan(liquid, verdict, 10000, fx, { costs }).cost!;
    expect(small.minFeeBelowDkk).toBe(16667);
    expect(small.minFeeWarning).toBe(true);
    const big = generateTradeExecutionPlan(liquid, verdict, 50000, fx, { costs }).cost!; // 85 → hele rammen
    expect(big.minFeeWarning).toBe(false);
    // 50.000 kr. → 28 aktier = 48.412 kr.; kurtage 2 × 0,15 % + 0 % FX + 0,1 % spread = 0,4 %
    expect(big.pct).toBeCloseTo(0.4, 2);
    expect(big.liquidityKnown).toBe(true);
  });

  it('uden costs-config ingen omkostningslinje (intet gæt)', () => {
    expect(generateTradeExecutionPlan(liquid, verdict, 25000, fx).cost).toBeUndefined();
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

  const cph = { exchangeName: 'CPH', fullExchangeName: 'Copenhagen', instrumentType: 'EQUITY', currency: 'DKK' };
  const dk = tx({ ticker: 'SMALL.CO', companyName: 'Small A/S' });

  it('nordisk likviditet omregnes til USD: 1 mio. DKK/dag (ca. $150k) afvises', () => {
    const r = verifyDkTradability(dk, { ...cph, currentPrice: 120, avgDailyDollarVolume: 1_000_000 }, fx);
    expect(r.isTradableInDK).toBe(false);
    expect(r.tradabilityReason).toMatch(/Illikvid/);
    expect(r.avgDailyDollarVolume).toBeCloseTo(1_000_000 / 6.65, 0);
  });

  it('kursgrænsen $2 gælder også i DKK (12 DKK ≈ $1,80 afvises)', () => {
    const r = verifyDkTradability(dk, { ...cph, currentPrice: 12, avgDailyDollarVolume: 50_000_000 }, fx);
    expect(r.isTradableInDK).toBe(false);
    expect(r.tradabilityReason).toMatch(/Penny Stock.*12 DKK/);
  });

  it('uden live FX er en DKK-aktie ikke verificeret (aldrig "Verificeret")', () => {
    const r = verifyDkTradability(dk, { ...cph, currentPrice: 400, avgDailyDollarVolume: 50_000_000 }, null);
    expect(r.isTradableInDK).toBeUndefined();
    expect(r.tradabilityReason).toMatch(/valutakurs DKK\/USD mangler/);
    expect(verifyDkTradability(dk, { ...cph, currentPrice: 400, avgDailyDollarVolume: 50_000_000 }, fx).isTradableInDK).toBe(true);
  });
});

describe('mergeFxRates (gemte valutakurser)', () => {
  it('et par, der fejlede nu, beholder sin gemte kurs, og lastUpdated er det ældste par', () => {
    const saved: LiveFxRates = { ...fx, lastUpdated: '2026-11-04T12:00:00Z' };
    const fresh: LiveFxRates = {
      USD_DKK: { rate: 6.7, fetchedAt: '2026-11-05T09:00:00Z' },
      EUR_DKK: { rate: 7.47, fetchedAt: '2026-11-05T09:00:00Z' },
      fxIsLive: false,
      lastUpdated: '2026-11-05T09:00:00Z',
    };
    const m = mergeFxRates(saved, fresh);
    expect(m.USD_DKK?.rate).toBe(6.7);
    expect(m.SEK_DKK).toEqual(q(0.68));
    expect(m.lastUpdated).toBe('2026-11-04T12:00:00Z');
    expect(mergeFxRates(undefined, fresh).lastUpdated).toBe('2026-11-05T09:00:00Z');
  });
});
