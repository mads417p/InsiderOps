import fs from 'fs';
import path from 'path';
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

const DB_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DB_DIR, 'insiderops-db.json');

/**
 * Sikrer at data-mappen og database-filen eksisterer.
 */
function ensureDbFile(): void {
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    if (!fs.existsSync(DB_FILE)) {
      const initial: DatabaseSchema = {
        verdicts: {},
        scanHistory: {},
        paperPortfolio: {},
      };
      fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf-8');
    }
  } catch (err) {
    console.error('Fejl ved initialisering af data/insiderops-db.json:', err);
  }
}

/**
 * Læser den fulde database fra disk.
 */
export async function getDatabase(): Promise<DatabaseSchema> {
  ensureDbFile();
  try {
    const raw = await fs.promises.readFile(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      verdicts: parsed.verdicts || {},
      scanHistory: parsed.scanHistory || {},
      paperPortfolio: parsed.paperPortfolio || {},
    };
  } catch (err) {
    console.error('Fejl ved læsning af insiderops-db.json:', err);
    return {
      verdicts: {},
      scanHistory: {},
      paperPortfolio: {},
    };
  }
}

/**
 * Gemmer den opdaterede database atomisk til disk.
 */
export async function saveDatabase(db: DatabaseSchema): Promise<void> {
  ensureDbFile();
  try {
    const tempFile = `${DB_FILE}.tmp.${Date.now()}`;
    await fs.promises.writeFile(tempFile, JSON.stringify(db, null, 2), 'utf-8');
    await fs.promises.rename(tempFile, DB_FILE);
  } catch (err) {
    console.error('Fejl ved skrivning til insiderops-db.json:', err);
  }
}

/**
 * Henter alle gemte domme fra server-databasen.
 */
export async function getSavedVerdicts(): Promise<Record<string, SavedVerdictItem>> {
  const db = await getDatabase();
  return db.verdicts;
}

/**
 * Gemmer en afsagt rådsdom i server-databasen.
 */
export async function saveVerdict(item: SavedVerdictItem): Promise<void> {
  const db = await getDatabase();
  db.verdicts[item.transaction.id] = item;
  await saveDatabase(db);
}

/**
 * Sletter en rådsdom fra server-databasen ud fra transaktions-id.
 */
export async function deleteVerdict(txId: string): Promise<boolean> {
  const db = await getDatabase();
  if (db.verdicts[txId]) {
    delete db.verdicts[txId];
    await saveDatabase(db);
    return true;
  }
  return false;
}

/**
 * Henter seneste gemte scan-resultat for en specifik kilde (mock, live, csuite, nordic).
 */
export async function getLatestScan(
  source: string
): Promise<Array<{ transaction: InsiderTransaction; result: GatekeeperResult }> | null> {
  const db = await getDatabase();
  const record = db.scanHistory[source];
  if (!record || !Array.isArray(record.items) || record.items.length === 0) {
    return null;
  }
  return record.items;
}

/**
 * Gemmer det seneste scan-resultat for en kilde.
 */
export async function saveScan(
  source: string,
  items: Array<{ transaction: InsiderTransaction; result: GatekeeperResult }>
): Promise<void> {
  const db = await getDatabase();
  db.scanHistory[source] = {
    source,
    scannedAt: new Date().toISOString(),
    items,
  };
  await saveDatabase(db);
}

/**
 * Henter alle paper-trade positioner fra server-databasen.
 */
export async function getPaperPortfolio(): Promise<Record<string, PaperTradePosition>> {
  const db = await getDatabase();
  return db.paperPortfolio || {};
}

/**
 * Gemmer eller opdaterer en paper-trade position i server-databasen.
 */
export async function savePaperTrade(pos: PaperTradePosition): Promise<void> {
  const db = await getDatabase();
  if (!db.paperPortfolio) {
    db.paperPortfolio = {};
  }
  db.paperPortfolio[pos.id] = pos;
  await saveDatabase(db);
}

/**
 * Sletter en paper-trade position fra server-databasen ud fra id.
 */
export async function deletePaperTrade(id: string): Promise<boolean> {
  const db = await getDatabase();
  if (db.paperPortfolio && db.paperPortfolio[id]) {
    delete db.paperPortfolio[id];
    await saveDatabase(db);
    return true;
  }
  return false;
}
