/**
 * Engangsmigration (fase 1, punkt 1h): fjerner den opdigtede judgeThinking-tekst fra ældre domme.
 *
 * Kørsel (fra repo-roden, med dev-serveren STOPPET – køen i db.ts dækker kun én proces):
 *   npx tsx scripts/migrate-legacy-thinking.ts
 *
 * Tag backup af data/insiderops-db.json først. Idempotent: rører kun domme, hvis judgeThinking
 * indeholder den hardkodede "Adaptive Cognitive Trace"-tekst fra den gamle claude-council.ts.
 */
import { updateDb } from '../src/lib/db';

const FABRICATED_MARKER = 'Adaptive Cognitive Trace';

async function main() {
  const changed = await updateDb((db) => {
    const ids: string[] = [];
    for (const [id, item] of Object.entries(db.verdicts)) {
      const v = item.verdict;
      if (!v?.judgeThinking?.includes(FABRICATED_MARKER)) continue;
      delete v.judgeThinking;
      v.legacyThinkingRemoved = true;
      if (v.modelsUsed?.judge) v.modelsUsed.judge = v.modelsUsed.judge.replace(/\s*\(Extended Thinking\)\s*$/, '');
      ids.push(id);
    }
    return ids;
  });
  console.log(`Opdigtet judgeThinking fjernet fra ${changed.length} domme.`);
}

main().catch((err) => {
  console.error('Migration fejlede – intet er skrevet:', err);
  process.exitCode = 1;
});
