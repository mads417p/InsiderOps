import type { CostsConfig } from '@/lib/costs';

/** Ren beregning uden fs, så både server (costs.ts) og klient (trade-planner i page.tsx) kan bruge den. */

const MARKET_BY_CURRENCY: Record<string, string> = { USD: 'US', DKK: 'CPH', SEK: 'STO', EUR: 'HEL', NOK: 'OSL' };

export interface RoundTripCost {
  pct: number; // af handelsbeløbet
  dkk: number;
  /** Under dette beløb pr. ordre koster minimumskurtagen mere end procentsatsen (minDkk / pct). */
  minFeeBelowDkk: number;
  liquidityKnown: boolean;
}

/**
 * Estimeret round-trip for én handel: købet i `buyOrders` lige store ordrer, salget i én ordre.
 * Kurtage pr. ordre = max(min-gebyr, % af ordren) → købssiden koster max(N × min / beløb, %).
 * Plus 2 × FX-spread for valutaen og spread/slippage efter likviditet (ukendt → laveste spand, konservativt).
 * Ukendt marked eller valuta → undefined. Med standardværdierne er tallet det samme som prereg-formlen.
 */
export function roundTripCost(
  c: CostsConfig,
  s: { currency: string; avgDailyDollarVolume?: number | null; tradeSizeDkk?: number; buyOrders?: number }
): RoundTripCost | undefined {
  const currency = s.currency.toUpperCase();
  const fee = c.brokerage[MARKET_BY_CURRENCY[currency] ?? ''];
  const fxPct = c.fxSpreadPctByCurrency[currency];
  const size = s.tradeSizeDkk ?? c.assumedTradeSizeDkk;
  if (!fee || fxPct === undefined || !(size > 0)) return undefined;

  const brokeragePct = (orders: number) => Math.max(((orders * fee.minDkk) / size) * 100, fee.pct);
  const buckets = [...c.roundTripSpreadSlippagePctByLiquidity].sort((a, b) => b.minAvgDailyUsd - a.minAvgDailyUsd);
  const adv = s.avgDailyDollarVolume ?? undefined;
  const slip = (adv !== undefined ? buckets.find((b) => adv >= b.minAvgDailyUsd) : undefined) ?? buckets[buckets.length - 1];

  const pct = brokeragePct(Math.max(1, s.buyOrders ?? 1)) + brokeragePct(1) + 2 * fxPct + slip.pct;
  return {
    pct,
    dkk: (size * pct) / 100,
    minFeeBelowDkk: fee.pct > 0 ? fee.minDkk / (fee.pct / 100) : Infinity,
    liquidityKnown: adv !== undefined,
  };
}

/**
 * Faktisk tarif for én ordre (kurtage + veksling) i DKK – til rigtige handler, hvor spread allerede ligger i kursen.
 * Ukendt marked eller valuta → undefined.
 */
export function orderCostDkk(c: CostsConfig, currency: string, amountDkk: number): number | undefined {
  const cur = currency.toUpperCase();
  const fee = c.brokerage[MARKET_BY_CURRENCY[cur] ?? ''];
  const fxPct = c.fxSpreadPctByCurrency[cur];
  if (!fee || fxPct === undefined || !(amountDkk > 0)) return undefined;
  return Math.max(fee.minDkk, (fee.pct / 100) * amountDkk) + (fxPct / 100) * amountDkk;
}
