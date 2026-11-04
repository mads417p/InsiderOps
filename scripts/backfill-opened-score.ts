/**
 * Engangs-backfill (fase 2.5, punkt 2b): positioner fra før openedScore fik feltet sat ved åbning.
 * openedScore = asymmetryScore, fordi asymmetryScore aldrig er ændret efter åbning (PATCH, refresh og
 * close rører den ikke). Rører intet andet. Idempotent: positioner med openedScore springes over.
 *
 * Kørsel (fra repo-roden, med dev-serveren STOPPET – køen i db.ts dækker kun én proces):
 *   npx tsx scripts/backfill-opened-score.ts            (viser hvad der ville ændres)
 *   npx tsx scripts/backfill-opened-score.ts --write    (skriver)
 * Tag backup af data/insiderops-db.json først.
 */
import { getDatabase, updateDb } from '../src/lib/db';
import type { PaperTradePosition } from '../src/types/insider';

export const needsOpenedScore = (p: PaperTradePosition) =>
  p.openedScore === undefined && Number.isInteger(p.asymmetryScore);

async function main() {
  const write = process.argv.includes('--write');
  const positions = Object.values((await getDatabase()).paperPortfolio);
  const todo = positions.filter(needsOpenedScore);
  for (const p of positions) {
    console.log(`${p.ticker.padEnd(6)} ${p.id.padEnd(40)} ${needsOpenedScore(p) ? `openedScore ← ${p.asymmetryScore}` : `uændret (openedScore ${p.openedScore})`}`);
  }
  if (!write) {
    console.log(`\n${todo.length} positioner ville blive ændret. Kør med --write for at skrive.`);
    return;
  }
  const changed = await updateDb((db) => {
    let n = 0;
    for (const p of Object.values(db.paperPortfolio)) {
      if (!needsOpenedScore(p)) continue; // tjek igen inde i låsen
      p.openedScore = p.asymmetryScore;
      n++;
    }
    return n;
  });
  console.log(`\n${changed} positioner opdateret.`);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/backfill-opened-score.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
