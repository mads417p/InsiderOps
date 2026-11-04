import { describe, expect, it } from 'vitest';
import { councilPostSchema, idSchema, portfolioPatchSchema, portfolioPostSchema } from '@/lib/api-schemas';
import { findTransactionForCouncil, type DatabaseSchema } from '@/lib/db';
import type { InsiderTransaction } from '@/types/insider';

const validPost = { ticker: 'ACN', asymmetryScore: 81, insiderBuyPrice: 245.98, shares: 3, stopLossPrice: 220, targetPrice: 290 };

describe('zod på mutationer (audit P2)', () => {
  it('portfolio-POST: score påkrævet, ingen NaN eller negative priser', () => {
    expect(portfolioPostSchema.safeParse(validPost).success).toBe(true);
    const { asymmetryScore: _omit, ...noScore } = validPost;
    expect(portfolioPostSchema.safeParse(noScore).success).toBe(false); // før: standard 85
    expect(portfolioPostSchema.safeParse({ ...validPost, stopLossPrice: -5 }).success).toBe(false);
    expect(portfolioPostSchema.safeParse({ ...validPost, insiderBuyPrice: Number.NaN }).success).toBe(false);
    expect(portfolioPostSchema.safeParse({ ...validPost, asymmetryScore: 140 }).success).toBe(false);
    expect(portfolioPostSchema.safeParse({ ...validPost, entryPrice: 1 }).success).toBe(false); // klienten bestemmer ikke entry
  });

  it('id må ikke ramme Object.prototype', () => {
    expect(idSchema.safeParse('__proto__').success).toBe(false);
    expect(idSchema.safeParse('constructor').success).toBe(false);
    expect(portfolioPatchSchema.safeParse({ id: '__proto__', stopLossPrice: 1 }).success).toBe(false);
    expect(idSchema.safeParse('oi-000143774926034881-1541375').success).toBe(true);
  });

  it('portfolio-PATCH: lukning og redigering; NaN afvises', () => {
    expect(portfolioPatchSchema.safeParse({ id: 'p1', action: 'close' }).success).toBe(true);
    expect(portfolioPatchSchema.safeParse({ id: 'p1', action: 'close', exitPrice: 0 }).success).toBe(false);
    expect(portfolioPatchSchema.safeParse({ id: 'p1', shares: Number.NaN }).success).toBe(false);
    expect(portfolioPatchSchema.safeParse({ id: 'p1', action: 'delete' }).success).toBe(false);
  });

  it('council-POST tager kun id (+ tier/forceRefresh) – ikke en transaktion fra klienten', () => {
    expect(councilPostSchema.safeParse({ id: 'x', judgeTier: 'opus', forceRefresh: true }).success).toBe(true);
    expect(councilPostSchema.safeParse({ id: 'x', transaction: { ticker: 'EVIL' } }).success).toBe(false);
  });
});

describe('council henter transaktionen server-side', () => {
  const tx = (id: string, ticker: string) => ({ id, ticker }) as InsiderTransaction;
  const db = {
    verdicts: { old: { transaction: tx('old', 'RAPP'), verdict: {}, savedAt: '' } },
    scanHistory: {
      gammel: { source: 'gammel', scannedAt: '2026-11-01T00:00:00Z', items: [{ transaction: { ...tx('a', 'ACN'), shares: 1 }, result: {} }] },
      ny: { source: 'ny', scannedAt: '2026-11-04T00:00:00Z', items: [{ transaction: { ...tx('a', 'ACN'), shares: 2 }, result: {} }] },
    },
    paperPortfolio: {},
  } as unknown as DatabaseSchema;

  it('nyeste scan vinder; ellers tidligere dom; ukendt id → null', () => {
    expect(findTransactionForCouncil(db, 'a')?.shares).toBe(2);
    expect(findTransactionForCouncil(db, 'old')?.ticker).toBe('RAPP');
    expect(findTransactionForCouncil(db, 'ukendt')).toBeNull();
    expect(findTransactionForCouncil(db, '__proto__')).toBeNull();
  });

  it('returnerer en kopi (berigelse ændrer ikke den gemte scan)', () => {
    const copy = findTransactionForCouncil(db, 'a')!;
    copy.shares = 999;
    expect(findTransactionForCouncil(db, 'a')?.shares).toBe(2);
  });
});
