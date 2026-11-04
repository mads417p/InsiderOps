/**
 * READ-ONLY inspektion af gemte domme og positioner i data/insiderops-db.json.
 *
 * Kørsel (fra repo-roden):
 *   npx tsx scripts/inspect-verdicts.ts                 # læser data/insiderops-db.json
 *   npx tsx scripts/inspect-verdicts.ts <sti-til-db>    # anden fil, fx en backup
 *   npx tsx scripts/inspect-verdicts.ts --json          # rå rækker som JSON (til før/efter-sammenligning)
 *
 * Scriptet skriver ALDRIG til disk. Det kalder bevidst ikke getDatabase() fra src/lib/db.ts,
 * fordi den sletter "mock"-poster og gemmer DB'en igen. Kun isMockEntity importeres, så reglen
 * er præcis den samme som i appen.
 *
 * Tjek pr. dom og pr. position (jf. docs/roadmap-edge.md, prompt 0, punkt 6):
 *   - ticker, score, verdict, modelsUsed, evaluatedAt
 *   - headline indeholder "SIMULERET" (eller simulatorens modelnavne)
 *   - ligner judge-fallback: score præcis 70 og ingen gyldig JSON i synthesis
 *   - fundamentals mangler XBRL-tal: cash eller gæld er 0/undefined
 *   - trackRecord matcher en mock-ticker (NVCR, PLXR, MTLR, PLAN) eller mock-navne
 *   - id, entryPrice eller ticker rammes af isMockEntity
 */
import fs from 'fs';
import path from 'path';
import { isMockEntity, type DatabaseSchema, type SavedVerdictItem } from '../src/lib/db';
import type { PaperTradePosition } from '../src/types/insider';

const FOCUS_TICKERS = ['RAPP', 'APLD', 'ACN'];
const MOCK_TRACK_RECORD_TICKERS = ['NVCR', 'PLXR', 'MTLR', 'PLAN'];
// Navne fra de hårdkodede mock-track-records i src/lib/track-record.ts
const MOCK_TRACK_RECORD_NAMES = ['Sarah Jenkins', 'Marcus Hall', 'Marcus Vance', 'Robert Sterling'];
// Labels fra fallbackDefaultRecord og den nordiske gren i track-record.ts (ukendt → FIRST_TIME_OR_RARE)
const TRACK_RECORD_FALLBACK_MARKERS = ['Kunne ikke hente historiske data', 'Fejl ved historisk opslag', 'Nordisk MAR'];
// Overskrift som claude-council.ts bygger, når dommerens JSON ikke kan parses
const JUDGE_FALLBACK_HEADLINE = /^Rådsdom for .+: .+ køb$/;
// Id, der ikke selv rammer nogen regel; bruges til at teste ticker- og entryPrice-reglerne hver for sig
const PROBE_ID = '__inspect_probe__';

const VERDICT_SHORT: Record<string, string> = {
  'STRONG ASYMMETRY (KØB)': 'KØB',
  'MODERATE SIGNAL (OVERVÅG)': 'OVERVÅG',
  'PR STUNT / STØJ (IGNORER)': 'IGNORER',
};

interface Row {
  kind: 'dom' | 'position';
  key: string;
  ticker: string;
  score: number | null;
  verdict: string;
  modelsUsed: string;
  evaluatedAt: string;
  simulated: string;
  judgeFallback: string;
  xbrlMissing: string;
  trackRecordMock: string;
  mockEntity: string;
  notes: string[];
}

function fmtNum(n: unknown): string {
  if (n === undefined) return 'undefined';
  if (n === null) return 'null';
  return String(n);
}

function shortVerdict(v: unknown): string {
  if (typeof v !== 'string' || v === '') return '–';
  return Object.hasOwn(VERDICT_SHORT, v) ? VERDICT_SHORT[v] : `⚠ ukendt: ${v}`;
}

/** 'gyldig' = indeholder et {...}-objekt der kan parses; 'ugyldig' = har klammer men parser ikke; 'ingen' = ingen klammer. */
function jsonInText(text: unknown): 'gyldig' | 'ugyldig' | 'ingen' {
  if (typeof text !== 'string') return 'ingen';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return 'ingen';
  try {
    JSON.parse(m[0]);
    return 'gyldig';
  } catch {
    return 'ugyldig';
  }
}

function checkSimulated(item: SavedVerdictItem): string {
  const v = item.verdict;
  const reasons: string[] = [];
  if (typeof v?.headline === 'string' && v.headline.toUpperCase().includes('SIMULERET')) reasons.push('headline');
  const spec = v?.modelsUsed?.specialists ?? '';
  const judge = v?.modelsUsed?.judge ?? '';
  // generateSimulatedCouncil sætter disse faste (udgåede) modelnavne
  if (spec.includes('3x Parallel') || judge.startsWith('Claude 3 Opus') || judge.includes('(Fast Mode)')) {
    reasons.push('simulator-modelnavn');
  }
  return reasons.length ? `JA (${reasons.join(' + ')})` : 'nej';
}

function checkJudgeFallback(item: SavedVerdictItem): string {
  const v = item.verdict;
  if (v?.asymmetryScore !== 70) return 'nej';
  const json = jsonInText(v.synthesis);
  const template = typeof v.headline === 'string' && JUDGE_FALLBACK_HEADLINE.test(v.headline);
  if (json !== 'gyldig') return `JA (score 70, JSON i synthesis: ${json}${template ? ', fallback-headline' : ''})`;
  return template ? 'MULIG (score 70 + fallback-headline)' : 'nej';
}

function checkXbrl(item: SavedVerdictItem): string {
  const f = item.transaction?.fundamentals;
  if (!f) return 'JA (ingen fundamentals)';
  const missing: string[] = [];
  const cash = f.cashAndEquivalentsUsd;
  const debt = f.totalDebtUsd;
  if (cash === undefined || cash === null || cash === 0) missing.push(`cash=${fmtNum(cash)}`);
  if (debt === undefined || debt === null || debt === 0) missing.push(`gæld=${fmtNum(debt)}`);
  return missing.length ? `JA (${missing.join(', ')})` : 'nej';
}

function checkTrackRecord(item: SavedVerdictItem): string {
  const ticker = (item.transaction?.ticker ?? '').toUpperCase().trim();
  const tr = item.transaction?.trackRecord;
  if (MOCK_TRACK_RECORD_TICKERS.includes(ticker)) return `JA (mock-ticker ${ticker})`;
  if (!tr) return 'ingen trackRecord';
  const names = (tr.notablePastTrades ?? [])
    .map((t) => t?.insiderName)
    .filter((n): n is string => typeof n === 'string' && MOCK_TRACK_RECORD_NAMES.includes(n));
  if (names.length) return `JA (mock-navn: ${[...new Set(names)].join(', ')})`;
  const label = tr.reputationLabel ?? '';
  const fallback = TRACK_RECORD_FALLBACK_MARKERS.find((m) => label.includes(m));
  if (fallback) return `nej, men fallback (${fallback} → ${tr.reputation})`;
  return 'nej';
}

/** Tester hver input-del for sig, så man kan se HVILKEN regel der rammer. */
function checkMockEntity(id: string, ticker?: string, entryPrice?: number): string {
  const hits: string[] = [];
  if (isMockEntity(id)) hits.push(`id "${id}"`);
  if (ticker !== undefined && isMockEntity(PROBE_ID, ticker)) hits.push(`ticker ${ticker}`);
  if (entryPrice !== undefined && isMockEntity(PROBE_ID, undefined, entryPrice)) hits.push(`entryPrice ${entryPrice}`);
  const combined = isMockEntity(id, ticker, entryPrice);
  if (hits.length) return `JA (${hits.join(', ')})`;
  return combined ? 'JA (kombination)' : 'nej';
}

function fmtModels(item: SavedVerdictItem | undefined): string {
  const m = item?.verdict?.modelsUsed;
  if (!m) return '–';
  return `${m.specialists ?? '?'} / ${m.judge ?? '?'}`;
}

function fmtEvaluatedAt(item: SavedVerdictItem | undefined): string {
  const v = item?.verdict;
  if (!v) return '–';
  if (v.evaluatedAt) return v.evaluatedAt;
  if (v.timestamp) return `${v.timestamp} (timestamp)`;
  if (item?.savedAt) return `${item.savedAt} (savedAt)`;
  return '–';
}

function timeOf(item: SavedVerdictItem): number {
  const s = item.verdict?.evaluatedAt ?? item.verdict?.timestamp ?? item.savedAt ?? '';
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

function verdictRow(key: string, item: SavedVerdictItem): Row {
  const v = item.verdict;
  const notes: string[] = [];
  const f = item.transaction?.fundamentals;
  if (f) {
    notes.push(`badge ${f.fundamentalHealthBadge}, runway ${fmtNum(f.estimatedRunwayMonths)} mdr.`);
  }
  const tr = item.transaction?.trackRecord;
  if (tr) notes.push(`trackRecord ${tr.reputation} (${tr.historicalBuysCount} køb)`);
  if (typeof v?.previousScore === 'number') notes.push(`previousScore ${v.previousScore}`);
  return {
    kind: 'dom',
    key,
    ticker: item.transaction?.ticker ?? '?',
    score: typeof v?.asymmetryScore === 'number' ? v.asymmetryScore : null,
    verdict: shortVerdict(v?.verdict),
    modelsUsed: fmtModels(item),
    evaluatedAt: fmtEvaluatedAt(item),
    simulated: checkSimulated(item),
    judgeFallback: checkJudgeFallback(item),
    xbrlMissing: checkXbrl(item),
    trackRecordMock: checkTrackRecord(item),
    mockEntity: checkMockEntity(key, item.transaction?.ticker),
    notes,
  };
}

function positionRow(key: string, pos: PaperTradePosition, verdictsByTicker: Map<string, Array<[string, SavedVerdictItem]>>): Row {
  const ticker = (pos.ticker ?? '').toUpperCase().trim();
  const matches = verdictsByTicker.get(ticker) ?? [];
  const latest = matches.length ? matches.reduce((a, b) => (timeOf(b[1]) > timeOf(a[1]) ? b : a)) : undefined;
  const item = latest?.[1];
  const noVerdict = 'n/a (ingen gemt dom)';

  const notes: string[] = [
    `id ${pos.id ?? key}`,
    `${pos.tradeType ?? 'PAPER?'} / ${pos.status}`,
    `entryPrice ${fmtNum(pos.entryPrice)}`,
    `openedAt ${pos.openedAt ?? '–'}`,
  ];
  if (latest) {
    notes.push(`dom: ${latest[0]}${matches.length > 1 ? ` (nyeste af ${matches.length})` : ''}`);
    if (item?.verdict?.asymmetryScore !== pos.asymmetryScore) {
      notes.push(`positionens score ${fmtNum(pos.asymmetryScore)} ≠ dommens ${fmtNum(item?.verdict?.asymmetryScore)}`);
    }
  } else {
    notes.push('ingen dom i DB for tickeren');
    if (pos.asymmetryScore === 85) notes.push('score 85 = POST-default i /api/portfolio, hvis score manglede');
  }
  if (pos.benchmarkEntryPrice === 755) notes.push('benchmarkEntryPrice 755 = SPY-fallback');
  if (pos.benchmarkEntryPrice === undefined) notes.push('ingen benchmarkEntryPrice');

  return {
    kind: 'position',
    key,
    ticker: pos.ticker ?? '?',
    score: typeof pos.asymmetryScore === 'number' ? pos.asymmetryScore : null,
    verdict: item ? shortVerdict(item.verdict?.verdict) : noVerdict,
    modelsUsed: item ? fmtModels(item) : noVerdict,
    evaluatedAt: item ? fmtEvaluatedAt(item) : noVerdict,
    simulated: item ? checkSimulated(item) : noVerdict,
    judgeFallback: item ? checkJudgeFallback(item) : noVerdict,
    xbrlMissing: item ? checkXbrl(item) : noVerdict,
    trackRecordMock: item ? checkTrackRecord(item) : noVerdict,
    mockEntity: checkMockEntity(pos.id ?? key, pos.ticker, pos.entryPrice),
    notes,
  };
}

function cell(s: unknown): string {
  return String(s ?? '–').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

function printTable(rows: Row[]): void {
  const header = ['Type', 'Nøgle', 'Ticker', 'Score', 'Verdict', 'modelsUsed', 'evaluatedAt', 'SIMULERET', 'Judge-fallback', 'XBRL mangler', 'TR mock', 'isMockEntity'];
  console.log(`| ${header.join(' | ')} |`);
  console.log(`|${header.map(() => '---').join('|')}|`);
  for (const r of rows) {
    const cols = [r.kind, r.key, r.ticker, r.score ?? '–', r.verdict, r.modelsUsed, r.evaluatedAt, r.simulated, r.judgeFallback, r.xbrlMissing, r.trackRecordMock, r.mockEntity];
    console.log(`| ${cols.map(cell).join(' | ')} |`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const pathArg = args.find((a) => !a.startsWith('--'));
  const dbPath = path.resolve(process.cwd(), pathArg ?? path.join('data', 'insiderops-db.json'));

  if (!fs.existsSync(dbPath)) {
    console.error(`Fandt ikke DB-filen: ${dbPath}`);
    console.error('Kør fra repo-roden, eller angiv stien: npx tsx scripts/inspect-verdicts.ts <sti-til-db.json>');
    process.exitCode = 1;
    return;
  }

  const raw = fs.readFileSync(dbPath, 'utf-8');
  let db: Partial<DatabaseSchema>;
  try {
    db = JSON.parse(raw) as Partial<DatabaseSchema>;
  } catch (err) {
    console.error(`DB-filen kan ikke parses som JSON: ${dbPath}`);
    console.error(err);
    process.exitCode = 1;
    return;
  }

  const verdicts = Object.entries(db.verdicts ?? {});
  const positions = Object.entries(db.paperPortfolio ?? {});

  const verdictsByTicker = new Map<string, Array<[string, SavedVerdictItem]>>();
  for (const entry of verdicts) {
    const t = (entry[1]?.transaction?.ticker ?? '').toUpperCase().trim();
    verdictsByTicker.set(t, [...(verdictsByTicker.get(t) ?? []), entry]);
  }

  const rows: Row[] = [
    ...verdicts.map(([k, item]) => verdictRow(k, item)),
    ...positions.map(([k, pos]) => positionRow(k, pos, verdictsByTicker)),
  ];

  if (asJson) {
    console.log(JSON.stringify({ dbPath, rows }, null, 2));
    return;
  }

  const stat = fs.statSync(dbPath);
  console.log(`# Inspektion af ${dbPath}`);
  console.log(`Filen er sidst ændret ${stat.mtime.toISOString()} · ${verdicts.length} domme · ${positions.length} positioner · ${Object.keys(db.scanHistory ?? {}).length} scan-kilder\n`);

  console.log('## Alle domme og positioner\n');
  printTable(rows);

  console.log('\n## Fokus: ' + FOCUS_TICKERS.join(', ') + '\n');
  for (const t of FOCUS_TICKERS) {
    const focusRows = rows.filter((r) => r.ticker.toUpperCase().trim() === t);
    if (!focusRows.length) {
      console.log(`### ${t}\n- FINDES IKKE i DB'en (hverken dom eller position). Er posten slettet, fx af isMockEntity-oprydningen i getDatabase()?\n`);
      continue;
    }
    console.log(`### ${t}`);
    for (const r of focusRows) {
      console.log(`- ${r.kind} \`${r.key}\`: score ${r.score ?? '–'}, ${r.verdict}, evaluatedAt ${r.evaluatedAt}`);
      console.log(`  - modelsUsed: ${r.modelsUsed}`);
      console.log(`  - SIMULERET: ${r.simulated} · judge-fallback: ${r.judgeFallback}`);
      console.log(`  - XBRL mangler: ${r.xbrlMissing} · TR mock: ${r.trackRecordMock} · isMockEntity: ${r.mockEntity}`);
      if (r.notes.length) console.log(`  - noter: ${r.notes.join(' · ')}`);
    }
    console.log('');
  }

  const count = (pred: (r: Row) => boolean) => rows.filter(pred).length;
  const yes = (s: string) => s.startsWith('JA');
  console.log('## Opsummering\n');
  console.log(`- SIMULERET: ${count((r) => r.kind === 'dom' && yes(r.simulated))} af ${verdicts.length} domme`);
  console.log(`- Judge-fallback: ${count((r) => r.kind === 'dom' && yes(r.judgeFallback))} af ${verdicts.length} domme`);
  console.log(`- XBRL mangler (cash eller gæld 0/undefined): ${count((r) => r.kind === 'dom' && yes(r.xbrlMissing))} af ${verdicts.length} domme`);
  console.log(`- trackRecord fra mock: ${count((r) => r.kind === 'dom' && yes(r.trackRecordMock))} af ${verdicts.length} domme`);
  console.log(`- trackRecord-fallback (ukendt → positiv kategori): ${count((r) => r.kind === 'dom' && r.trackRecordMock.startsWith('nej, men fallback'))} af ${verdicts.length} domme`);
  console.log(`- Rammes af isMockEntity: ${count((r) => yes(r.mockEntity))} af ${rows.length} rækker (de slettes ved næste getDatabase())`);
  console.log(`- Positioner uden gemt dom: ${count((r) => r.kind === 'position' && r.verdict.startsWith('n/a'))} af ${positions.length}`);
}

main();
