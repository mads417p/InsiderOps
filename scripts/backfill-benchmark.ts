/**
 * Engangs-backfill (fase 2, punkt 5a): ældre positioner får de tal, alpha i DKK kræver.
 *   - entryUsdDkk: USD-positioner bruger deres egen entryFxRateDkk (= USD/DKK ved entry);
 *     andre henter USDDKK=X-lukkekursen på eller før openedAt (Yahoo).
 *   - benchmarkEntryPrice: mangler den eller er den 755 (den gamle hårdkodede reserve), hentes SPY's
 *     lukkekurs på eller før openedAt (Yahoo).
 * Rører intet andet. Idempotent: felter, der allerede er udfyldt (og ikke er 755), springes over.
 *
 * Kørsel (fra repo-roden, med dev-serveren STOPPET – køen i db.ts dækker kun én proces):
 *   npx tsx scripts/backfill-benchmark.ts            (viser hvad der ville ændres)
 *   npx tsx scripts/backfill-benchmark.ts --write    (skriver)
 * Tag backup af data/insiderops-db.json først.
 */
import { getDatabase, updateDb } from '../src/lib/db';
import { currencyForTicker } from '../src/lib/live-quote';
import type { PaperTradePosition } from '../src/types/insider';

const LEGACY_SPY_FALLBACK = 755;

/** Seneste lukkekurs på eller før datoen (YYYY-MM-DD). */
export function closeOnOrBefore(dates: string[], closes: number[], date: string): number | undefined {
  let best: number | undefined;
  for (let i = 0; i < dates.length; i++) if (dates[i] <= date && closes[i] > 0) best = closes[i];
  return best;
}

async function yahooCloseOnOrBefore(symbol: string, isoDate: string): Promise<number> {
  const day = isoDate.slice(0, 10);
  const end = Math.floor(Date.parse(`${day}T23:59:59Z`) / 1000);
  const start = end - 10 * 86_400; // dækker weekender og helligdage
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${start}&period2=${end}&interval=1d`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error(`Yahoo ${symbol} svarede ${res.status}`);
  const r = (await res.json())?.chart?.result?.[0];
  const dates: string[] = (r?.timestamp ?? []).map((t: number) => new Date(t * 1000).toISOString().slice(0, 10));
  const close = closeOnOrBefore(dates, r?.indicators?.quote?.[0]?.close ?? [], day);
  if (close === undefined) throw new Error(`Ingen ${symbol}-lukkekurs på eller før ${day}`);
  return close;
}

export function needsBackfill(p: PaperTradePosition): { usdDkk: boolean; spy: boolean } {
  return {
    usdDkk: !(typeof p.entryUsdDkk === 'number' && p.entryUsdDkk > 0),
    spy: !(typeof p.benchmarkEntryPrice === 'number' && p.benchmarkEntryPrice > 0) || p.benchmarkEntryPrice === LEGACY_SPY_FALLBACK,
  };
}

async function main() {
  const write = process.argv.includes('--write');
  const positions = Object.values((await getDatabase()).paperPortfolio);
  const patches: Record<string, Partial<PaperTradePosition>> = {};

  for (const p of positions) {
    const need = needsBackfill(p);
    const patch: Partial<PaperTradePosition> = {};
    if (need.usdDkk) {
      patch.entryUsdDkk =
        currencyForTicker(p.ticker) === 'USD' && p.entryFxRateDkk > 0
          ? p.entryFxRateDkk
          : await yahooCloseOnOrBefore('USDDKK=X', p.openedAt);
    }
    if (need.spy) patch.benchmarkEntryPrice = await yahooCloseOnOrBefore('SPY', p.openedAt);
    if (Object.keys(patch).length > 0) patches[p.id] = patch;
    console.log(`${p.ticker.padEnd(6)} ${p.openedAt.slice(0, 10)}  ${Object.keys(patch).length ? JSON.stringify(patch) : 'uændret'}`);
  }

  if (!write) {
    console.log(`\n${Object.keys(patches).length} positioner ville blive ændret. Kør med --write for at skrive.`);
    return;
  }
  const changed = await updateDb((db) => {
    let n = 0;
    for (const [id, patch] of Object.entries(patches)) {
      if (!Object.hasOwn(db.paperPortfolio, id)) continue;
      const need = needsBackfill(db.paperPortfolio[id]); // tjek igen inde i låsen
      if (need.usdDkk && patch.entryUsdDkk) db.paperPortfolio[id].entryUsdDkk = patch.entryUsdDkk;
      if (need.spy && patch.benchmarkEntryPrice) db.paperPortfolio[id].benchmarkEntryPrice = patch.benchmarkEntryPrice;
      n++;
    }
    return n;
  });
  console.log(`\nBackfill skrevet for ${changed} positioner.`);
}

if (process.argv[1]?.includes('backfill-benchmark')) {
  main().catch((err) => {
    console.error('Backfill fejlede – intet er skrevet:', err);
    process.exitCode = 1;
  });
}
