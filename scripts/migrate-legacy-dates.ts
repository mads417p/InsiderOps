/**
 * Engangsmigration (fase 2, punkt 1e): det gamle felt `filingDate` betød forskellige ting pr. kilde.
 * Det erstattes af `tradeDate` (handelsdato) og `filedAt` (indberetning/offentliggørelse):
 *   - `sec-…`      (EDGAR, periodOfReport)            → tradeDate
 *   - `exec-buy-…` / `live-buy-…` (OpenInsider Filing Date) → filedAt
 *   - `nordic-…`   (Nasdaq Nordic releaseTime)        → filedAt
 *   - alt andet                                         → filedAt (den sikre side: ikke en handelsdato)
 * Gælder transaktionerne i verdicts og scanHistory. Positioner har intet filingDate.
 *
 * Kørsel (fra repo-roden, med dev-serveren STOPPET – køen i db.ts dækker kun én proces):
 *   npx tsx scripts/migrate-legacy-dates.ts
 * Tag backup af data/insiderops-db.json først. Idempotent: rører kun poster, der stadig har filingDate.
 */
import { updateDb } from '../src/lib/db';
import type { InsiderTransaction } from '../src/types/insider';

type Legacy = InsiderTransaction & { filingDate?: string };

export function migrateTransaction(tx: Legacy | undefined): boolean {
  if (!tx || tx.filingDate === undefined) return false;
  const value = tx.filingDate;
  delete tx.filingDate;
  if (!value) return true;
  if (tx.id?.startsWith('sec-')) tx.tradeDate ??= value;
  else tx.filedAt ??= value;
  return true;
}

async function main() {
  const counts = await updateDb((db) => {
    let verdicts = 0;
    let scanRows = 0;
    for (const item of Object.values(db.verdicts)) if (migrateTransaction(item.transaction as Legacy)) verdicts++;
    for (const scan of Object.values(db.scanHistory)) {
      for (const it of scan.items || []) if (migrateTransaction(it.transaction as Legacy)) scanRows++;
    }
    return { verdicts, scanRows };
  });
  console.log(`filingDate migreret: ${counts.verdicts} domme, ${counts.scanRows} scan-rækker.`);
}

if (process.argv[1]?.includes('migrate-legacy-dates')) {
  main().catch((err) => {
    console.error('Migration fejlede – intet er skrevet:', err);
    process.exitCode = 1;
  });
}
