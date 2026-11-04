import fs from 'fs';
import path from 'path';
import { z } from 'zod';

/**
 * Handelsomkostninger fra config/costs.json (tracked i git; samme fil bruges af research/ i fase 4).
 * Filen læses ved hvert kald, så rettede satser slår igennem uden genstart. Ugyldig fil → kast (fail loud).
 */

const pct = z.number().min(0).max(100);
const costsSchema = z.object({
  TODO: z.string().optional(), // findes nøglen, er satserne pladsholdere → UI-advarsel
  version: z.number(),
  assumedTradeSizeDkk: z.number().positive(),
  brokerage: z.record(z.string(), z.object({ minDkk: z.number().min(0), pct })),
  fxSpreadPct: pct,
  roundTripSpreadSlippagePctByLiquidity: z.array(z.object({ minAvgDailyUsd: z.number().min(0), pct })).min(1),
});
export type CostsConfig = z.infer<typeof costsSchema>;

export function loadCosts(): CostsConfig {
  const file = path.join(process.cwd(), 'config', 'costs.json');
  return costsSchema.parse(JSON.parse(fs.readFileSync(file, 'utf-8')));
}

const MARKET_BY_CURRENCY: Record<string, string> = { USD: 'US', DKK: 'CPH', SEK: 'STO', EUR: 'HEL', NOK: 'OSL' };

/**
 * Estimeret round-trip-omkostning i procent af handelsbeløbet:
 * 2 × kurtage (min-gebyr eller %, det største) + 2 × FX-spread (ikke-DKK) + spread/slippage efter likviditet.
 * Ukendt likviditet → laveste likviditetsspand (konservativt). Ukendt marked → undefined.
 */
export function roundTripCostPct(c: CostsConfig, s: { currency: string; avgDailyDollarVolume?: number | null }): number | undefined {
  const currency = s.currency.toUpperCase();
  const fee = c.brokerage[MARKET_BY_CURRENCY[currency] ?? ''];
  if (!fee) return undefined;
  const brokeragePct = Math.max((fee.minDkk / c.assumedTradeSizeDkk) * 100, fee.pct);
  const fxPct = currency === 'DKK' ? 0 : c.fxSpreadPct;
  const buckets = [...c.roundTripSpreadSlippagePctByLiquidity].sort((a, b) => b.minAvgDailyUsd - a.minAvgDailyUsd);
  const adv = s.avgDailyDollarVolume ?? undefined;
  const slip = (adv !== undefined ? buckets.find((b) => adv >= b.minAvgDailyUsd) : undefined) ?? buckets[buckets.length - 1];
  return 2 * brokeragePct + 2 * fxPct + slip.pct;
}
