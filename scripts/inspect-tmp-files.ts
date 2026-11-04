/**
 * READ-ONLY: sammenligner efterladte data/insiderops-db.json.tmp.*-filer med den nuværende DB.
 *
 * Kørsel (fra repo-roden):
 *   npx tsx scripts/inspect-tmp-files.ts            # data/
 *   npx tsx scripts/inspect-tmp-files.ts <mappe>    # fx data/backups/tmp-arkiv (DB'en læses stadig fra data/)
 *
 * For hver tmp-fil: om den er gyldig JSON, mtime, og hvilke domme og positioner den har, som
 * enten mangler i den nuværende DB eller er nyere end dér. Scriptet skriver ALDRIG til disk.
 *
 * "Nyere": dom = verdict.evaluatedAt ?? verdict.timestamp ?? savedAt; position = lastQuoteTime ?? openedAt.
 */
import fs from 'fs';
import path from 'path';
import type { DatabaseSchema, SavedVerdictItem } from '../src/lib/db';
import type { PaperTradePosition } from '../src/types/insider';

const dir = process.argv[2] ?? 'data';
const dbPath = path.join('data', 'insiderops-db.json');
const current = JSON.parse(fs.readFileSync(dbPath, 'utf-8')) as DatabaseSchema;

const verdictTime = (v?: SavedVerdictItem) => v?.verdict?.evaluatedAt ?? v?.verdict?.timestamp ?? v?.savedAt;
const positionTime = (p?: PaperTradePosition) => p?.lastQuoteTime ?? p?.openedAt;
const isNewer = (tmp?: string, now?: string) => !!tmp && (!now || Date.parse(tmp) > Date.parse(now));
const fmt = (iso?: string) => (iso ? iso.replace('T', ' ').slice(0, 19) : '–');

interface Finding {
  file: string;
  kind: 'dom' | 'position';
  key: string;
  ticker: string;
  tmpTime?: string;
  nowTime?: string;
  status: 'mangler i DB' | 'nyere i tmp';
}

const files = fs
  .readdirSync(dir)
  .filter((f) => /^insiderops-db\.json\.tmp\./.test(f))
  .sort();

const summary: string[] = [];
const findings: Finding[] = [];

for (const file of files) {
  const full = path.join(dir, file);
  const mtime = fs.statSync(full).mtime.toISOString();
  let tmp: Partial<DatabaseSchema>;
  try {
    tmp = JSON.parse(fs.readFileSync(full, 'utf-8'));
  } catch (err) {
    summary.push(`| ${file} | ${fmt(mtime)} | NEJ (${(err as Error).message.slice(0, 50)}) | – | – | – |`);
    continue;
  }

  const verdicts = Object.entries(tmp.verdicts ?? {});
  const positions = Object.entries(tmp.paperPortfolio ?? {});
  const before = findings.length;

  for (const [key, v] of verdicts) {
    const now = current.verdicts[key];
    const status = !now ? 'mangler i DB' : isNewer(verdictTime(v), verdictTime(now)) ? 'nyere i tmp' : null;
    if (status) {
      findings.push({ file, kind: 'dom', key, ticker: v?.transaction?.ticker ?? '?', tmpTime: verdictTime(v), nowTime: verdictTime(now), status });
    }
  }
  for (const [key, p] of positions) {
    const now = current.paperPortfolio[key];
    const status = !now ? 'mangler i DB' : isNewer(positionTime(p), positionTime(now)) ? 'nyere i tmp' : null;
    if (status) {
      findings.push({ file, kind: 'position', key, ticker: p?.ticker ?? '?', tmpTime: positionTime(p), nowTime: positionTime(now), status });
    }
  }

  summary.push(`| ${file} | ${fmt(mtime)} | ja | ${verdicts.length} | ${positions.length} | ${findings.length - before} |`);
}

console.log(`DB: ${dbPath} (${Object.keys(current.verdicts).length} domme, ${Object.keys(current.paperPortfolio).length} positioner)`);
console.log(`Tmp-filer i ${dir}: ${files.length}\n`);
console.log('| Fil | mtime (UTC) | Gyldig JSON | Domme | Positioner | Fund |');
console.log('|---|---|---|---|---|---|');
summary.forEach((row) => console.log(row));

console.log('\n| Fil | Type | Id / nøgle | Ticker | Tid i tmp | Tid i DB nu | Status |');
console.log('|---|---|---|---|---|---|---|');
for (const f of findings) {
  console.log(`| ${f.file} | ${f.kind} | ${f.key} | ${f.ticker} | ${fmt(f.tmpTime)} | ${fmt(f.nowTime)} | ${f.status} |`);
}
if (findings.length === 0) console.log('| – | – | – | – | – | – | Ingen fund |');
