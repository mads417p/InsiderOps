/**
 * Udfaldsjob (fase 3, 4): beregner manglende udfald (1/5/21/63 handelsdage) for signal-ledgeren, når
 * horisonten er nået. Manglende kurs giver ingen række; beregnede udfald overskrives aldrig (DB-triggers).
 * Må køre samtidig med dev-serveren (SQLite WAL + busy-timeout).
 *
 * Kørsel (fra repo-roden):
 *   npm run outcomes                              (beregner og gemmer)
 *   npx tsx scripts/compute-outcomes.ts           (tør kørsel: viser hvad der ville blive gemt)
 */
import { computeMissingOutcomes } from '../src/lib/outcomes';

async function main() {
  const write = process.argv.includes('--write');
  const r = await computeMissingOutcomes({ write });
  console.log(`${write ? 'Gemt' : 'Ville gemme'}: ${r.inserted} udfald · ikke nået endnu: ${r.notReached}`);
  for (const f of r.fetchErrors) console.log(`  Kursdata kunne ikke hentes for ${f.symbol}: ${f.error}`);
  for (const m of r.missingData) console.log(`  Mangler data: ${m.signalId} (${m.horizon} d): ${m.reason}`);
  if (!write) console.log('\nTør kørsel – kør "npm run outcomes" for at gemme.');
}

if (process.argv[1]?.includes('compute-outcomes')) {
  main().catch((err) => {
    console.error('Udfaldsjobbet fejlede:', err);
    process.exitCode = 1;
  });
}
