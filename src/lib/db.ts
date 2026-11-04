import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  CouncilVerdict,
  GatekeeperResult,
  InsiderTransaction,
  PaperTradePosition,
} from '@/types/insider';

export interface SavedVerdictItem {
  transaction: InsiderTransaction;
  verdict: CouncilVerdict;
  savedAt: string;
}

export interface SavedScanItem {
  source: string;
  scannedAt: string;
  items: Array<{
    transaction: InsiderTransaction;
    result: GatekeeperResult;
  }>;
}

export interface DatabaseSchema {
  verdicts: Record<string, SavedVerdictItem>;
  scanHistory: Record<string, SavedScanItem>;
  paperPortfolio: Record<string, PaperTradePosition>;
}

// Stien beregnes ved hvert kald (ikke ved import), så tests kan pege process.cwd() på en tmp-mappe.
const dbFile = () => path.join(process.cwd(), 'data', 'insiderops-db.json');

/**
 * Afgør om en post er mock og derfor renses. Matcher KUN på id-præfikset "mock-" – aldrig på ticker eller kurs.
 * Eksporteret, så scripts/inspect-verdicts.ts og tests bruger præcis samme regel som appen.
 */
export function isMockEntity(id: string): boolean {
  return typeof id === 'string' && id.startsWith('mock-');
}

/**
 * Læser og normaliserer DB'en. Mangler filen (første kørsel), er DB'en tom.
 * Alle andre læse- og parse-fejl kaster – der returneres aldrig en tom DB i stedet for data.
 */
async function readDb(): Promise<DatabaseSchema> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(dbFile(), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { verdicts: {}, scanHistory: {}, paperPortfolio: {} };
    }
    throw new Error(`Kunne ikke læse ${dbFile()}: ${(err as Error).message}`);
  }

  let parsed: Partial<DatabaseSchema>;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`DB-filen ${dbFile()} er korrupt (ugyldig JSON): ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`DB-filen ${dbFile()} har ikke den forventede struktur`);
  }

  const verdicts: Record<string, SavedVerdictItem> = {};
  for (const [k, v] of Object.entries(parsed.verdicts || {})) {
    if (!isMockEntity(k)) verdicts[k] = v;
  }

  const scanHistory: Record<string, SavedScanItem> = {};
  for (const [k, v] of Object.entries(parsed.scanHistory || {})) {
    if (k === 'mock') continue;
    scanHistory[k] = { ...v, items: (v?.items || []).filter((it) => !isMockEntity(it.transaction?.id)) };
  }

  // Positioner returneres, som de er gemt – ingen opfundne FX-, kurs- eller kildeværdier ved læsning.
  const paperPortfolio: Record<string, PaperTradePosition> = {};
  for (const [k, p] of Object.entries(parsed.paperPortfolio || {})) {
    if (!isMockEntity(k)) paperPortfolio[k] = p;
  }

  return { verdicts, scanHistory, paperPortfolio };
}

/**
 * Skriver atomisk: kopi af nuværende fil til .bak, unik temp-fil, rename. Fejl kastes.
 */
async function writeDb(db: DatabaseSchema): Promise<void> {
  const file = dbFile();
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.promises.copyFile(file, file.replace(/\.json$/, '.bak.json'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(db, null, 2), 'utf-8');
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}

const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Windows: antivirus, indeksering eller en anden læser kan holde filen kortvarigt, så rename fejler med
 * EPERM/EBUSY/EACCES. Prøv igen med stigende backoff (10 forsøg, ca. 2 s i alt) som graceful-fs, og kast derefter.
 */
export async function renameWithRetry(from: string, to: string, attempts = 10): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      return await fs.promises.rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (i >= attempts || !RETRYABLE_RENAME.has(code)) throw err;
      await new Promise((r) => setTimeout(r, 40 * i)); // 40+80+…+360 ms ≈ 1,8 s
    }
  }
}

// ponytail: kø i processen (på globalThis, så Next' separate route-bundles deler den).
// Dækker ikke to processer (fx dev-server + script samtidig) – fil-lås, hvis det bliver aktuelt.
const g = globalThis as typeof globalThis & { __insiderOpsDbQueue?: Promise<unknown> };

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = (g.__insiderOpsDbQueue ?? Promise.resolve()).then(task);
  g.__insiderOpsDbQueue = run.catch(() => undefined);
  return run;
}

/** Læser hele DB'en (serialiseret med skrivninger). Kaster ved læse- eller parse-fejl. */
export function getDatabase(): Promise<DatabaseSchema> {
  return enqueue(readDb);
}

/**
 * Eneste skrivevej: læs → fn(db) muterer → skriv, som én udelelig operation i processen.
 * Fejler læsningen, kaldes fn ikke, og der skrives intet.
 */
export function updateDb<T>(fn: (db: DatabaseSchema) => T | Promise<T>): Promise<T> {
  return enqueue(async () => {
    const db = await readDb();
    const result = await fn(db);
    await writeDb(db);
    return result;
  });
}

export async function getSavedVerdicts(): Promise<Record<string, SavedVerdictItem>> {
  return (await getDatabase()).verdicts;
}

export function saveVerdict(item: SavedVerdictItem): Promise<void> {
  return updateDb((db) => {
    db.verdicts[item.transaction.id] = item;
  });
}

export function deleteVerdict(txId: string): Promise<boolean> {
  return updateDb((db) => {
    const existed = txId in db.verdicts;
    delete db.verdicts[txId];
    return existed;
  });
}

export async function getLatestScan(
  source: string
): Promise<Array<{ transaction: InsiderTransaction; result: GatekeeperResult }> | null> {
  const record = (await getDatabase()).scanHistory[source];
  return record?.items?.length ? record.items : null;
}

export function saveScan(
  source: string,
  items: Array<{ transaction: InsiderTransaction; result: GatekeeperResult }>
): Promise<void> {
  return updateDb((db) => {
    db.scanHistory[source] = { source, scannedAt: new Date().toISOString(), items };
  });
}

export async function getPaperPortfolio(): Promise<Record<string, PaperTradePosition>> {
  return (await getDatabase()).paperPortfolio;
}

export function savePaperTrade(pos: PaperTradePosition): Promise<void> {
  return updateDb((db) => {
    db.paperPortfolio[pos.id] = pos;
  });
}

export function deletePaperTrade(id: string): Promise<boolean> {
  return updateDb((db) => {
    const existed = id in db.paperPortfolio;
    delete db.paperPortfolio[id];
    return existed;
  });
}
