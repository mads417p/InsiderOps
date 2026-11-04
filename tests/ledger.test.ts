import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeLedger,
  filedAtToUtc,
  getLedger,
  insertOutcome,
  listOutcomes,
  listSignals,
  recordEvaluation,
  recordSignals,
  signalIdFor,
  type OutcomeRow,
} from '@/lib/ledger';
import type { CouncilVerdict, GatekeeperResult, InsiderTransaction } from '@/types/insider';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insiderops-ledger-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
});

afterEach(() => {
  closeLedger();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const tx = (o: Partial<InsiderTransaction> = {}): InsiderTransaction => ({
  id: 'oi-000122520826008642-2041310',
  accessionNo: '000122520826008642',
  ownerCik: '2041310',
  tradeDate: '2026-10-30',
  filedAt: '2026-11-03T19:37:23',
  ticker: 'BA',
  companyName: 'Boeing Co',
  insiderName: 'Buckley Mortimer J',
  insiderTitle: 'Dir',
  transactionCode: 'P',
  shares: 5820,
  pricePerShare: 171.55,
  currency: 'USD',
  totalValueUsd: 998421,
  isClusterBuy: false,
  secFilingUrl: 'https://www.sec.gov/Archives/edgar/data/12927/000122520826008642/doc4.xml',
  currentMarketPrice: 177,
  ...o,
});

const result = (score: number, scoreSource: GatekeeperResult['scoreSource'] = 'claude'): GatekeeperResult => ({
  passedHardFilter: true,
  geminiPreScore: score,
  scoreSource,
  asymmetrySignal: 'MEDIUM',
  quickReasoning: 'test',
});

const fx = { USD_DKK: { rate: 6.5, fetchedAt: '2026-11-04T21:00:00Z' }, fxIsLive: false, lastUpdated: '2026-11-04T21:00:00Z' };

const scan = (passed: InsiderTransaction[], items: Array<{ transaction: InsiderTransaction; result: GatekeeperResult }>, at: string) =>
  recordSignals({ passed, items, scanSource: 'unified', detectedAt: at, gatekeeperModel: 'claude-haiku-5-5', fx });

describe('ledger: signalidentitet', () => {
  it('SEC-id = accession + owner CIK; uden dem en stabil rå nøgle', () => {
    expect(signalIdFor(tx())).toBe('acc:000122520826008642:2041310');
    const raw = tx({ id: 'exec-buy-BA-x', accessionNo: undefined, ownerCik: undefined });
    expect(signalIdFor(raw)).toBe(signalIdFor({ ...raw, id: 'exec-buy-BA-y' }));
  });

  it('nordisk id = meddelelses-id + person; fallback-id uden disclosureId bruger rå nøgle', () => {
    const n = tx({ id: 'nordic-1475008', accessionNo: undefined, ownerCik: undefined, currency: 'DKK', insiderName: 'Lars Hansen' });
    expect(signalIdFor(n)).toBe('nordic:1475008:lars hansen');
    expect(signalIdFor({ ...n, id: 'nordic-nordic-3' })).toMatch(/^raw:/);
  });

  it('OpenInsider-filedAt (ET uden tidszone) normaliseres til UTC med sommertid', () => {
    expect(filedAtToUtc({ id: 'oi-x', filedAt: '2026-11-03T19:37:23', currency: 'USD' })).toBe('2026-11-04T00:37:23.000Z'); // EST
    expect(filedAtToUtc({ id: 'oi-x', filedAt: '2026-10-30T16:00:00', currency: 'USD' })).toBe('2026-10-30T20:00:00.000Z'); // EDT
    expect(filedAtToUtc({ id: 'sec-x', filedAt: '2026-11-04T16:05:12-05:00', currency: 'USD' })).toBe('2026-11-04T21:05:12.000Z');
    expect(filedAtToUtc({ id: 'nordic-1', filedAt: '2026-11-04 09:00', currency: 'DKK' })).toBeUndefined();
  });
});

describe('ledger: append-only', () => {
  it('samme signal i to scans giver én række; detectedAt bevares, lastSeenAt opdateres', () => {
    const a = tx();
    expect(scan([a], [{ transaction: a, result: result(66) }], '2026-11-04T21:00:00.000Z')).toEqual({ inserted: 1, seen: 0, scored: 1 });
    expect(scan([a], [{ transaction: a, result: result(40) }], '2026-11-05T21:00:00.000Z')).toEqual({ inserted: 0, seen: 1, scored: 0 });
    const rows = listSignals();
    expect(rows).toHaveLength(1);
    expect(rows[0].detectedAt).toBe('2026-11-04T21:00:00.000Z');
    expect(rows[0].lastSeenAt).toBe('2026-11-05T21:00:00.000Z');
    expect(rows[0].gatekeeperScore).toBe(66); // write-once: senere score ignoreres
  });

  it('co-købere i en cluster logges som hver sit signal med lead-info i features', () => {
    const lead = tx({ isClusterBuy: true, clusterCount: 2 });
    const peer = tx({ id: 'oi-000122520826008650-1111', accessionNo: '000122520826008650', ownerCik: '1111', insiderName: 'Mollenkopf Steven M' });
    scan([lead, peer], [{ transaction: lead, result: result(66) }], '2026-11-04T21:00:00.000Z');
    const rows = listSignals();
    expect(rows.map((r) => r.id).sort()).toEqual(['acc:000122520826008642:2041310', 'acc:000122520826008650:1111']);
    expect(rows.every((r) => r.gatekeeperScore === 66)).toBe(true);
    expect(JSON.parse(rows[1].featuresJson).rollUp.leadSignalId).toBe('acc:000122520826008642:2041310');
  });

  it('heuristisk score låser ikke; en senere Claude-score udfylder feltet', () => {
    const a = tx();
    scan([a], [{ transaction: a, result: result(80, 'heuristik') }], '2026-11-04T21:00:00.000Z');
    expect(listSignals()[0].gatekeeperScore).toBeNull();
    scan([a], [{ transaction: a, result: result(55) }], '2026-11-05T14:00:00.000Z');
    const row = listSignals()[0];
    expect([row.gatekeeperScore, row.scoreSource, row.scoredAt]).toEqual([55, 'claude', '2026-11-05T14:00:00.000Z']);
  });

  it('DB-triggers afviser ændring og sletning af historik', () => {
    const a = tx();
    scan([a], [{ transaction: a, result: result(66) }], '2026-11-04T21:00:00.000Z');
    const db = getLedger();
    expect(() => db.exec("UPDATE signals SET ticker = 'X'")).toThrow(/append-only/);
    expect(() => db.exec('UPDATE signals SET gatekeeperScore = 99')).toThrow(/allerede sat/);
    expect(() => db.exec('DELETE FROM signals')).toThrow(/append-only/);
  });
});

describe('ledger: evaluations og outcomes', () => {
  const verdict = {
    asymmetryScore: 80,
    verdict: 'STRONG ASYMMETRY (KØB)',
    modelsUsed: { gatekeeper: 'claude-haiku-5-5', specialists: 'claude-sonnet-5-5', judge: 'claude-opus-5-5', judgeTier: 'opus' },
    promptVersion: 'fase3',
    evaluatedAt: '2026-11-04T22:00:00.000Z',
  } as unknown as CouncilVerdict;

  it('rådsdom gemmes med køregel; ukendt signal giver false', () => {
    const a = tx();
    scan([a], [{ transaction: a, result: result(66) }], '2026-11-04T21:00:00.000Z');
    expect(recordEvaluation({ tx: a, verdict, queueRule: 'auto:rang-top3-min50', costUsd: 0.1 })).toBe(true);
    expect(recordEvaluation({ tx: tx({ accessionNo: '9', id: 'x' }), verdict, queueRule: 'manuel' })).toBe(false);
    const db = getLedger();
    expect(db.prepare('SELECT queueRule, judgeModel, costUsd FROM evaluations').all()).toEqual([
      { queueRule: 'auto:rang-top3-min50', judgeModel: 'claude-opus-5-5', costUsd: 0.1 },
    ]);
    expect(() => db.exec('DELETE FROM evaluations')).toThrow(/append-only/);
  });

  it('et udfald overskrives aldrig', () => {
    const a = tx();
    scan([a], [{ transaction: a, result: result(66) }], '2026-11-04T21:00:00.000Z');
    const o = { signalId: signalIdFor(a), horizon: 5, retLocal: 0.02 } as unknown as OutcomeRow;
    const full: OutcomeRow = {
      ...o, anchorAt: 'x', currency: 'USD', entryDate: '2026-11-05', entryPrice: 1, exitDate: '2026-11-11', exitPrice: 1.02,
      fxEntry: 6.5, fxExit: 6.5, retDkk: 0.02, spyEntryDate: '2026-11-05', spyEntry: 1, spyExitDate: '2026-11-11', spyExit: 1,
      usdDkkEntry: 6.5, usdDkkExit: 6.5, spyRetUsd: 0, spyRetDkk: 0, abnormalDkk: 0.02, abnormalLocal: 0.02, dataSource: 'test', computedAt: 'x',
    };
    expect(insertOutcome(full)).toBe(true);
    expect(insertOutcome({ ...full, retLocal: 0.5 })).toBe(false);
    expect(listOutcomes()[0].retLocal).toBe(0.02);
    expect(() => getLedger().exec('UPDATE outcomes SET retLocal = 1')).toThrow(/append-only/);
  });
});
