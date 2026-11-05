import { describe, expect, it } from 'vitest';
import { costsFileSha256, loadCosts, roundTripCostPct, type CostsConfig } from '@/lib/costs';
import { PREREG } from '@/lib/ledger-stats';
import { roundTripCost } from '@/lib/round-trip';

const c: CostsConfig = {
  version: 1,
  assumedTradeSizeDkk: 20000,
  brokerage: { US: { minDkk: 39, pct: 0.15 }, CPH: { minDkk: 29, pct: 0.1 }, STO: { minDkk: 29, pct: 0.1 } },
  fxSpreadPctByCurrency: { USD: 0.25, DKK: 0, SEK: 0.25 },
  roundTripSpreadSlippagePctByLiquidity: [
    { minAvgDailyUsd: 0, pct: 1.2 },
    { minAvgDailyUsd: 50_000_000, pct: 0.1 },
    { minAvgDailyUsd: 5_000_000, pct: 0.3 },
  ],
};

describe('omkostninger (fase 3, 7)', () => {
  it('US: 2 × max(min-gebyr, %) + 2 × FX for valutaen + spread efter likviditet', () => {
    // 39/20000 = 0,195 % > 0,15 % → 2 × 0,195 + 2 × 0,25 + 0,1
    expect(roundTripCostPct(c, { currency: 'USD', avgDailyDollarVolume: 1.8e9 })).toBeCloseTo(0.99, 6);
  });

  it('DKK har ingen FX-spread; ukendt likviditet → værste spand', () => {
    expect(roundTripCostPct(c, { currency: 'DKK', avgDailyDollarVolume: 6e6 })).toBeCloseTo(2 * 0.145 + 0.3, 6);
    expect(roundTripCostPct(c, { currency: 'DKK' })).toBeCloseTo(2 * 0.145 + 1.2, 6);
  });

  it('ukendt marked eller valuta → undefined (intet gæt)', () => {
    expect(roundTripCostPct(c, { currency: 'NOK' })).toBeUndefined(); // hverken marked eller FX-sats
    expect(roundTripCostPct({ ...c, fxSpreadPctByCurrency: { DKK: 0 } }, { currency: 'SEK' })).toBeUndefined(); // FX-sats mangler
  });

  it('config/costs.json er frosset af prereg (version + sha256); en ændring kræver ny prereg-version', () => {
    const real = loadCosts();
    expect(real.version).toBe(PREREG.costsVersion);
    expect(costsFileSha256()).toBe(PREREG.costsSha256);
    expect(real.TODO).toBeUndefined();
  });

  it('Nordnet Standard, 10.000 kr., USD-valutakonto: US round-trip 0,6 / 0,8 / 1,1 / 1,7 %', () => {
    const real = loadCosts();
    // 2 × max(25/10.000 = 0,25 %, 0,15 %) + 2 × 0 % FX (valutakonto) + spread/slippage
    const us = (adv?: number) => roundTripCostPct(real, { currency: 'USD', avgDailyDollarVolume: adv });
    expect([us(6e7), us(6e6), us(2e6), us(5e5), us()].map((x) => Number(x!.toFixed(2)))).toEqual([0.6, 0.8, 1.1, 1.7, 1.7]);
    expect(roundTripCostPct(real, { currency: 'DKK', avgDailyDollarVolume: 6e7 })).toBeCloseTo(0.6, 10);
    // Sverige/Finland/Norge: automatisk veksling 0,25 % pr. handel
    expect(roundTripCostPct(real, { currency: 'SEK', avgDailyDollarVolume: 6e7 })).toBeCloseTo(0.6 + 0.5, 10);
  });

  it('roundTripCost: valgt handelsstørrelse og antal købsordrer (fase 9)', () => {
    const real = loadCosts();
    const us = (tradeSizeDkk: number, buyOrders = 1) =>
      roundTripCost(real, { currency: 'USD', avgDailyDollarVolume: 6e7, tradeSizeDkk, buyOrders })!;
    // 10.000 kr.: 2 × 25 kr. + 0,1 % spread = 60 kr. (0,6 %) – samme som prereg-tallet
    expect(us(10000).dkk).toBeCloseTo(60, 6);
    // 20.000 kr. over grænsen: 2 × 0,15 % + 0,1 % = 0,4 % = 80 kr.
    expect(us(20000).pct).toBeCloseTo(0.4, 10);
    // to købsordrer á 5.000 kr.: 3 × 25 kr. + 10 kr. spread = 85 kr.
    expect(us(10000, 2).dkk).toBeCloseTo(85, 6);
    expect(us(10000).minFeeBelowDkk).toBeCloseTo(16666.67, 1);
    expect(roundTripCost(real, { currency: 'DKK', tradeSizeDkk: 10000 })!.minFeeBelowDkk).toBe(25000);
    expect(roundTripCost(real, { currency: 'USD', tradeSizeDkk: 0 })).toBeUndefined();
  });
});
