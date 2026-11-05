import { createHash } from 'crypto';
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
  fxSpreadPctByCurrency: z.record(z.string(), pct), // pr. handel; USD 0 = valutakonto, DKK 0
  roundTripSpreadSlippagePctByLiquidity: z.array(z.object({ minAvgDailyUsd: z.number().min(0), pct })).min(1),
});
export type CostsConfig = z.infer<typeof costsSchema>;

const costsFile = () => path.join(process.cwd(), 'config', 'costs.json');

export function loadCosts(): CostsConfig {
  return costsSchema.parse(JSON.parse(fs.readFileSync(costsFile(), 'utf-8')));
}

/** sha256 af config/costs.json med LF-linjeskift (samme værdi i git, på Windows og i research/). */
export function costsFileSha256(): string {
  const lf = fs.readFileSync(costsFile(), 'utf-8').split('\r\n').join('\n');
  return createHash('sha256').update(lf, 'utf8').digest('hex');
}

const MARKET_BY_CURRENCY: Record<string, string> = { USD: 'US', DKK: 'CPH', SEK: 'STO', EUR: 'HEL', NOK: 'OSL' };

/**
 * Estimeret round-trip-omkostning i procent af handelsbeløbet:
 * 2 × kurtage (min-gebyr eller %, det største) + 2 × FX-spread for handelsvalutaen + spread/slippage efter likviditet.
 * Ukendt likviditet → laveste likviditetsspand (konservativt). Ukendt marked eller valuta → undefined.
 */
export function roundTripCostPct(c: CostsConfig, s: { currency: string; avgDailyDollarVolume?: number | null }): number | undefined {
  const currency = s.currency.toUpperCase();
  const fee = c.brokerage[MARKET_BY_CURRENCY[currency] ?? ''];
  const fxPct = c.fxSpreadPctByCurrency[currency];
  if (!fee || fxPct === undefined) return undefined;
  const brokeragePct = Math.max((fee.minDkk / c.assumedTradeSizeDkk) * 100, fee.pct);
  const buckets = [...c.roundTripSpreadSlippagePctByLiquidity].sort((a, b) => b.minAvgDailyUsd - a.minAvgDailyUsd);
  const adv = s.avgDailyDollarVolume ?? undefined;
  const slip = (adv !== undefined ? buckets.find((b) => adv >= b.minAvgDailyUsd) : undefined) ?? buckets[buckets.length - 1];
  return 2 * brokeragePct + 2 * fxPct + slip.pct;
}
