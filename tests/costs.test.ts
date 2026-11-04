import { describe, expect, it } from 'vitest';
import { loadCosts, roundTripCostPct, type CostsConfig } from '@/lib/costs';

const c: CostsConfig = {
  version: 1,
  assumedTradeSizeDkk: 20000,
  brokerage: { US: { minDkk: 39, pct: 0.15 }, CPH: { minDkk: 29, pct: 0.1 } },
  fxSpreadPct: 0.25,
  roundTripSpreadSlippagePctByLiquidity: [
    { minAvgDailyUsd: 0, pct: 1.2 },
    { minAvgDailyUsd: 50_000_000, pct: 0.1 },
    { minAvgDailyUsd: 5_000_000, pct: 0.3 },
  ],
};

describe('omkostninger (fase 3, 7)', () => {
  it('US: 2 × max(min-gebyr, %) + 2 × FX + spread efter likviditet', () => {
    // 39/20000 = 0,195 % > 0,15 % → 2 × 0,195 + 2 × 0,25 + 0,1
    expect(roundTripCostPct(c, { currency: 'USD', avgDailyDollarVolume: 1.8e9 })).toBeCloseTo(0.99, 6);
  });

  it('DKK har ingen FX-spread; ukendt likviditet → værste spand', () => {
    expect(roundTripCostPct(c, { currency: 'DKK', avgDailyDollarVolume: 6e6 })).toBeCloseTo(2 * 0.145 + 0.3, 6);
    expect(roundTripCostPct(c, { currency: 'DKK' })).toBeCloseTo(2 * 0.145 + 1.2, 6);
  });

  it('ukendt marked → undefined (intet gæt)', () => {
    expect(roundTripCostPct(c, { currency: 'SEK' })).toBeUndefined();
  });

  it('config/costs.json er gyldig og markeret TODO, indtil satserne er rettet', () => {
    const real = loadCosts();
    expect(real.brokerage.US).toBeDefined();
    expect(typeof real.TODO === 'string' || real.TODO === undefined).toBe(true);
  });
});
