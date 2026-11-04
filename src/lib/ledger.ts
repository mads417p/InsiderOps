import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeName, tradeKey } from '@/lib/sec-scanner';
import { getFxRateToDkk, type LiveFxRates } from '@/lib/live-quote';
import type { CouncilVerdict, GatekeeperResult, InsiderTransaction } from '@/types/insider';

/**
 * Signal-ledger (fase 3): append-only registrering af hvert signal, der består hard-filteret, punkt-i-tid.
 * Kun ledgeren ligger i SQLite (data/insiderops.db); verdicts, scans og positioner bliver i JSON-DB'en.
 * Append-only håndhæves af triggers i selve DB'en, så heller ikke et script kan justere historikken.
 */

export const FEATURE_VERSION = 'fase3-v1';
export const HORIZONS = [1, 5, 21, 63] as const;
export type Horizon = (typeof HORIZONS)[number];

const ledgerPath = () => path.join(process.cwd(), 'data', 'insiderops.db');

// Historiske felter i signals: kan aldrig ændres efter INSERT (kun lastSeenAt og write-once-scoren).
const FROZEN_SIGNAL_COLUMNS = [
  'id', 'detectedAt', 'source', 'scanSource', 'ticker', 'isin', 'exchange', 'currency', 'filedAtRaw', 'filedAtUtc',
  'tradeDate', 'accessionNo', 'ownerCik', 'insiderName', 'roles', 'shares', 'price', 'valueLocal', 'valueUsd',
  'ownership', 'is10b51', 'hardFilterResult', 'featureVersion', 'featuresJson', 'priceAtDetection', 'quoteSource',
  'quoteTime', 'fxToDkkAtDetection', 'usdDkkAtDetection', 'fxTime',
];
const SCORE_COLUMNS = ['gatekeeperScore', 'scoreSource', 'asymmetrySignal', 'gatekeeperModel', 'scoredAt'];

const noChange = (table: string, op: 'UPDATE' | 'DELETE') =>
  `CREATE TRIGGER ${table}_no_${op.toLowerCase()} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT, '${table} er append-only: ${op} er ikke tilladt'); END;`;

/** Migrationer i rækkefølge; PRAGMA user_version = antal kørte. Tilføj kun nye – ret aldrig en kørt. */
const MIGRATIONS = [
  `
  CREATE TABLE signals (
    id TEXT PRIMARY KEY,
    detectedAt TEXT NOT NULL,
    lastSeenAt TEXT NOT NULL,
    source TEXT NOT NULL,
    scanSource TEXT NOT NULL,
    ticker TEXT NOT NULL,
    isin TEXT,
    exchange TEXT,
    currency TEXT NOT NULL,
    filedAtRaw TEXT,
    filedAtUtc TEXT,
    tradeDate TEXT,
    accessionNo TEXT,
    ownerCik TEXT,
    insiderName TEXT NOT NULL,
    roles TEXT,
    shares REAL,
    price REAL,
    valueLocal REAL,
    valueUsd REAL,
    ownership TEXT,
    is10b51 INTEGER,
    hardFilterResult TEXT NOT NULL,
    featureVersion TEXT NOT NULL,
    featuresJson TEXT NOT NULL,
    gatekeeperScore INTEGER,
    scoreSource TEXT,
    asymmetrySignal TEXT,
    gatekeeperModel TEXT,
    scoredAt TEXT,
    priceAtDetection REAL,
    quoteSource TEXT,
    quoteTime TEXT,
    fxToDkkAtDetection REAL,
    usdDkkAtDetection REAL,
    fxTime TEXT
  ) STRICT;
  CREATE INDEX signals_ticker ON signals(ticker);
  CREATE INDEX signals_detected ON signals(detectedAt);
  ${noChange('signals', 'DELETE')}
  CREATE TRIGGER signals_frozen BEFORE UPDATE OF ${FROZEN_SIGNAL_COLUMNS.join(', ')} ON signals
    BEGIN SELECT RAISE(ABORT, 'signals er append-only: historiske felter kan ikke ændres'); END;
  CREATE TRIGGER signals_score_write_once BEFORE UPDATE OF ${SCORE_COLUMNS.join(', ')} ON signals
    WHEN OLD.scoredAt IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'signals: gatekeeper-scoren er allerede sat og kan ikke ændres'); END;

  CREATE TABLE evaluations (
    id INTEGER PRIMARY KEY,
    signalId TEXT NOT NULL REFERENCES signals(id),
    evaluatedAt TEXT NOT NULL,
    queueRule TEXT NOT NULL,
    gatekeeperModel TEXT,
    specialistModel TEXT,
    judgeModel TEXT,
    judgeTier TEXT,
    promptVersion TEXT,
    score INTEGER,
    verdict TEXT,
    flagsJson TEXT NOT NULL,
    usageJson TEXT,
    costUsd REAL,
    priceAtEvaluation REAL
  ) STRICT;
  CREATE INDEX evaluations_signal ON evaluations(signalId);
  ${noChange('evaluations', 'UPDATE')}
  ${noChange('evaluations', 'DELETE')}

  CREATE TABLE outcomes (
    signalId TEXT NOT NULL REFERENCES signals(id),
    horizon INTEGER NOT NULL CHECK (horizon IN (1, 5, 21, 63)),
    anchorAt TEXT NOT NULL,
    currency TEXT NOT NULL,
    entryDate TEXT NOT NULL,
    entryPrice REAL NOT NULL,
    exitDate TEXT NOT NULL,
    exitPrice REAL NOT NULL,
    retLocal REAL NOT NULL,
    fxEntry REAL NOT NULL,
    fxExit REAL NOT NULL,
    retDkk REAL NOT NULL,
    spyEntryDate TEXT NOT NULL,
    spyEntry REAL NOT NULL,
    spyExitDate TEXT NOT NULL,
    spyExit REAL NOT NULL,
    usdDkkEntry REAL NOT NULL,
    usdDkkExit REAL NOT NULL,
    spyRetUsd REAL NOT NULL,
    spyRetDkk REAL NOT NULL,
    abnormalDkk REAL NOT NULL,
    abnormalLocal REAL,
    dataSource TEXT NOT NULL,
    computedAt TEXT NOT NULL,
    PRIMARY KEY (signalId, horizon)
  ) STRICT;
  ${noChange('outcomes', 'UPDATE')}
  ${noChange('outcomes', 'DELETE')}
  `,
];

function migrate(db: DatabaseSync): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

// Én forbindelse pr. fil-sti på globalThis (Next kan bundle routes hver for sig – samme mønster som db.ts' kø).
const g = globalThis as unknown as { __insiderOpsLedger?: Map<string, DatabaseSync> };

export function getLedger(): DatabaseSync {
  const p = ledgerPath();
  const cache = (g.__insiderOpsLedger ??= new Map());
  let db = cache.get(p);
  if (!db) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    db = new DatabaseSync(p, { timeout: 5000 }); // busy-timeout: npm run outcomes kan køre samtidig med dev-serveren
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    migrate(db);
    cache.set(p, db);
  }
  return db;
}

/** Lukker forbindelsen for den aktuelle sti (tests og scripts). */
export function closeLedger(): void {
  const p = ledgerPath();
  g.__insiderOpsLedger?.get(p)?.close();
  g.__insiderOpsLedger?.delete(p);
}

type SqlValue = string | number | null;
const v = (x: unknown): SqlValue =>
  x === undefined || x === null ? null : typeof x === 'boolean' ? (x ? 1 : 0) : typeof x === 'number' ? (Number.isFinite(x) ? x : null) : String(x);

function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------------------------------------------------------------- signalidentitet og tid

/**
 * Signal-id: SEC = accession-nummer + reporting owner CIK (tradeKey); nordisk = meddelelses-id + person.
 * Uden stabilt id (manglende accession/CIK eller meddelelses-id) bruges tradeKey's råa nøgle
 * (ticker + navn + handelsdato + antal + kurs), så gentagne scans aldrig giver en ny række.
 */
export function signalIdFor(tx: InsiderTransaction): string {
  const nordic = /^nordic-(.+)$/.exec(tx.id)?.[1];
  if (nordic && !nordic.startsWith('nordic-')) return `nordic:${nordic}:${normalizeName(tx.insiderName)}`;
  return tradeKey(tx);
}

/** Lokal vægur-tid i en tidszone → UTC ISO. Håndterer sommertid. */
export function zonedToUtc(local: string, timeZone: string): string | undefined {
  const asUtc = Date.parse(`${local}Z`);
  if (Number.isNaN(asUtc)) return undefined;
  const offset = (t: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
        .formatToParts(t)
        .map((p) => [p.type, p.value])
    );
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - t;
  };
  const guess = asUtc - offset(asUtc);
  return new Date(asUtc - offset(guess)).toISOString();
}

/**
 * filedAt → UTC. Med tidszone (EDGAR-feed, nordisk "…Z"): direkte. Uden tidszone: OpenInsider/SEC er ET.
 * Nordisk uden tidszone er tvetydig → undefined (mangler data, ikke et gæt).
 */
export function filedAtToUtc(tx: Pick<InsiderTransaction, 'filedAt' | 'currency' | 'id'>): string | undefined {
  const raw = tx.filedAt?.trim();
  if (!raw) return undefined;
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  const isUs = !tx.id.startsWith('nordic-') && (!tx.currency || tx.currency === 'USD');
  if (isUs && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(raw)) return zonedToUtc(raw.length === 16 ? `${raw}:00` : raw, 'America/New_York');
  return undefined;
}

// ---------------------------------------------------------------- signals

export interface ScanItem {
  transaction: InsiderTransaction;
  result: GatekeeperResult;
}

export interface RecordSignalsInput {
  passed: InsiderTransaction[]; // alle unikke handler, der bestod hard-filteret (før cluster-roll-up)
  items: ScanItem[]; // roll-up-rækkerne med gatekeeper-resultat (én pr. ticker)
  scanSource: string; // unified | csuite | live | nordic | ticker:XYZ
  detectedAt: string; // scan-tidspunkt (UTC ISO)
  gatekeeperModel?: string;
  fx: LiveFxRates | null;
}

const isNordic = (tx: InsiderTransaction) => tx.id.startsWith('nordic-');

function featuresFor(tx: InsiderTransaction, rollUp: InsiderTransaction | undefined): string {
  // ponytail: hele transaktionen minus fritekst er feature-snapshot'et; featureVersion skifter, når formen ændres.
  const { contextNotes: _notes, clusterPeers: _peers, ...features } = tx;
  void _notes;
  void _peers;
  return JSON.stringify({
    ...features,
    rollUp: rollUp
      ? {
          leadSignalId: signalIdFor(rollUp),
          isClusterBuy: rollUp.isClusterBuy,
          clusterCount: rollUp.clusterCount,
          personalBuyers: rollUp.personalBuyers,
          fundBuyers: rollUp.fundBuyers,
        }
      : null,
  });
}

/**
 * Logger hvert signal første gang, det ses (detectedAt), og opdaterer kun lastSeenAt ved senere scans.
 * Gatekeeper-scoren er write-once: den sættes første gang, signalets ticker scores, og ændres aldrig.
 */
export function recordSignals(input: RecordSignalsInput): { inserted: number; seen: number; scored: number } {
  const db = getLedger();
  const byTicker = new Map(input.items.map((i) => [i.transaction.ticker.toUpperCase().trim(), i]));
  const usdDkk = getFxRateToDkk('USD', input.fx);
  const fxTime = input.fx?.USD_DKK?.fetchedAt ?? input.fx?.lastUpdated;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO signals (id, detectedAt, lastSeenAt, source, scanSource, ticker, isin, exchange, currency,
      filedAtRaw, filedAtUtc, tradeDate, accessionNo, ownerCik, insiderName, roles, shares, price, valueLocal, valueUsd,
      ownership, is10b51, hardFilterResult, featureVersion, featuresJson, priceAtDetection, quoteSource, quoteTime,
      fxToDkkAtDetection, usdDkkAtDetection, fxTime)
    VALUES (:id, :detectedAt, :detectedAt, :source, :scanSource, :ticker, :isin, :exchange, :currency,
      :filedAtRaw, :filedAtUtc, :tradeDate, :accessionNo, :ownerCik, :insiderName, :roles, :shares, :price, :valueLocal, :valueUsd,
      :ownership, :is10b51, :hardFilterResult, :featureVersion, :featuresJson, :priceAtDetection, :quoteSource, :quoteTime,
      :fxToDkkAtDetection, :usdDkkAtDetection, :fxTime)`);
  const touch = db.prepare('UPDATE signals SET lastSeenAt = :at WHERE id = :id AND lastSeenAt < :at');
  const score = db.prepare(`
    UPDATE signals SET gatekeeperScore = :score, scoreSource = :scoreSource, asymmetrySignal = :signal,
      gatekeeperModel = :model, scoredAt = :at
    WHERE id = :id AND scoredAt IS NULL`);

  return inTransaction(db, () => {
    const counts = { inserted: 0, seen: 0, scored: 0 };
    const done = new Set<string>();
    for (const tx of input.passed) {
      const id = signalIdFor(tx);
      if (done.has(id)) continue;
      done.add(id);
      const item = byTicker.get(tx.ticker.toUpperCase().trim());
      const currency = (tx.currency || 'USD').toUpperCase();
      const res = insert.run({
        id,
        detectedAt: input.detectedAt,
        source: isNordic(tx) ? 'Nasdaq Nordic (MAR art. 19)' : 'SEC Form 4',
        scanSource: input.scanSource,
        ticker: tx.ticker.toUpperCase().trim(),
        isin: v(tx.isin),
        exchange: v(tx.exchange),
        currency,
        filedAtRaw: v(tx.filedAt),
        filedAtUtc: v(filedAtToUtc(tx)),
        tradeDate: v(tx.tradeDate),
        accessionNo: v(tx.accessionNo),
        ownerCik: v(tx.ownerCik),
        insiderName: tx.insiderName,
        roles: v(tx.insiderTitle),
        shares: v(tx.shares),
        price: v(tx.pricePerShare),
        valueLocal: v(tx.totalValueLocal ?? (currency === 'USD' ? tx.totalValueUsd : undefined)),
        valueUsd: v(tx.totalValueUsd),
        ownership: v(tx.ownershipNature),
        is10b51: v(tx.is10b51Plan),
        hardFilterResult: tx.tradabilityReason ? `bestået: ${tx.tradabilityReason}` : 'bestået (handelbarhed ikke verificeret)',
        featureVersion: FEATURE_VERSION,
        featuresJson: featuresFor(tx, item?.transaction),
        priceAtDetection: v(tx.currentMarketPrice),
        quoteSource: tx.currentMarketPrice ? 'Yahoo chart 1d (seneste bar, market-enricher)' : null,
        quoteTime: v(tx.currentMarketPriceTime),
        fxToDkkAtDetection: v(getFxRateToDkk(currency, input.fx)),
        usdDkkAtDetection: v(usdDkk),
        fxTime: v(fxTime),
      });
      if (Number(res.changes) > 0) counts.inserted++;
      else {
        touch.run({ id, at: input.detectedAt });
        counts.seen++;
      }
      const r = item?.result;
      // Kun model-scorer låses; en heuristisk reserve-score efterlader feltet tomt til en senere Claude-score.
      if (r && r.passedHardFilter && r.scoreSource !== 'heuristik' && Number.isFinite(r.geminiPreScore)) {
        const s = score.run({
          id,
          score: Math.round(r.geminiPreScore),
          scoreSource: r.scoreSource,
          signal: r.asymmetrySignal,
          model: v(input.gatekeeperModel),
          at: input.detectedAt,
        });
        if (Number(s.changes) > 0) counts.scored++;
      }
    }
    return counts;
  });
}

// ---------------------------------------------------------------- evaluations

export interface RecordEvaluationInput {
  tx: InsiderTransaction;
  verdict: CouncilVerdict;
  queueRule: string;
  costUsd?: number;
}

/** Gemmer en rådsdom på signalet. false = signalet findes ikke i ledgeren (fx gammel række fra før fase 3). */
export function recordEvaluation(e: RecordEvaluationInput): boolean {
  const db = getLedger();
  const signalId = signalIdFor(e.tx);
  const res = db
    .prepare(
      `INSERT INTO evaluations (signalId, evaluatedAt, queueRule, gatekeeperModel, specialistModel, judgeModel, judgeTier,
        promptVersion, score, verdict, flagsJson, usageJson, costUsd, priceAtEvaluation)
       SELECT :signalId, :evaluatedAt, :queueRule, :gatekeeperModel, :specialistModel, :judgeModel, :judgeTier,
        :promptVersion, :score, :verdict, :flagsJson, :usageJson, :costUsd, :priceAtEvaluation
       WHERE EXISTS (SELECT 1 FROM signals WHERE id = :signalId)`
    )
    .run({
      signalId,
      evaluatedAt: e.verdict.evaluatedAt ?? new Date().toISOString(),
      queueRule: e.queueRule,
      gatekeeperModel: v(e.verdict.modelsUsed?.gatekeeper),
      specialistModel: v(e.verdict.modelsUsed?.specialists),
      judgeModel: v(e.verdict.modelsUsed?.judge),
      judgeTier: v(e.verdict.modelsUsed?.judgeTier),
      promptVersion: v(e.verdict.promptVersion),
      score: v(e.verdict.asymmetryScore),
      verdict: e.verdict.verdict,
      flagsJson: JSON.stringify({
        is10b51Plan: e.tx.is10b51Plan ?? null,
        isClusterBuy: e.tx.isClusterBuy,
        clusterCount: e.tx.clusterCount ?? null,
        personalBuyers: e.tx.personalBuyers ?? null,
        fundBuyers: e.tx.fundBuyers ?? null,
        offeringNote: e.tx.offeringNote ?? null,
        isTradableInDK: e.tx.isTradableInDK ?? null,
        validated: e.verdict.validated ?? null,
      }),
      usageJson: e.verdict.usage ? JSON.stringify(e.verdict.usage) : null,
      costUsd: v(e.costUsd),
      priceAtEvaluation: v(e.verdict.priceAtEvaluation),
    });
  return Number(res.changes) > 0;
}

// ---------------------------------------------------------------- læsning

export interface SignalRow {
  id: string;
  detectedAt: string;
  lastSeenAt: string;
  source: string;
  scanSource: string;
  ticker: string;
  currency: string;
  filedAtUtc: string | null;
  tradeDate: string | null;
  insiderName: string;
  is10b51: number | null;
  gatekeeperScore: number | null;
  scoreSource: string | null;
  scoredAt: string | null;
  featuresJson: string;
}

export interface OutcomeRow {
  signalId: string;
  horizon: number;
  anchorAt: string;
  currency: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  retLocal: number;
  fxEntry: number;
  fxExit: number;
  retDkk: number;
  spyEntryDate: string;
  spyEntry: number;
  spyExitDate: string;
  spyExit: number;
  usdDkkEntry: number;
  usdDkkExit: number;
  spyRetUsd: number;
  spyRetDkk: number;
  abnormalDkk: number;
  abnormalLocal: number | null;
  dataSource: string;
  computedAt: string;
}

export function listSignals(): SignalRow[] {
  return getLedger()
    .prepare(
      `SELECT id, detectedAt, lastSeenAt, source, scanSource, ticker, currency, filedAtUtc, tradeDate, insiderName, is10b51,
        gatekeeperScore, scoreSource, scoredAt, featuresJson FROM signals ORDER BY detectedAt`
    )
    .all() as unknown as SignalRow[];
}

export function listOutcomes(): OutcomeRow[] {
  return getLedger().prepare('SELECT * FROM outcomes').all() as unknown as OutcomeRow[];
}

/** Indsætter et udfald, hvis det ikke findes. Et beregnet udfald overskrives aldrig. */
export function insertOutcome(o: OutcomeRow): boolean {
  const cols = Object.keys(o);
  const res = getLedger()
    .prepare(`INSERT OR IGNORE INTO outcomes (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`)
    .run(Object.fromEntries(cols.map((c) => [c, v((o as unknown as Record<string, unknown>)[c])])));
  return Number(res.changes) > 0;
}
