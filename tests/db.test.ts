import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDatabase, isMockEntity, updateDb, type SavedVerdictItem } from '@/lib/db';

let dir: string;
const file = () => path.join(dir, 'data', 'insiderops-db.json');
const item = (id: string) => ({ transaction: { id }, verdict: {}, savedAt: '' }) as unknown as SavedVerdictItem;
const seed = (content: string) => fs.writeFileSync(file(), content, 'utf-8');
const empty = JSON.stringify({ verdicts: {}, scanHistory: {}, paperPortfolio: {} });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insiderops-db-'));
  fs.mkdirSync(path.join(dir, 'data'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('db.ts', () => {
  it('to samtidige updateDb-kald bevarer begge ændringer', async () => {
    seed(empty);
    await Promise.all([
      updateDb(async (db) => {
        await new Promise((r) => setTimeout(r, 30)); // uden kø ville det andet kald læse før denne skrivning
        db.verdicts.a = item('a');
      }),
      updateDb((db) => {
        db.verdicts.b = item('b');
      }),
    ]);
    const saved = JSON.parse(fs.readFileSync(file(), 'utf-8'));
    expect(Object.keys(saved.verdicts).sort()).toEqual(['a', 'b']);
  });

  it('en korrupt DB-fil kaster, og der skrives intet', async () => {
    const corrupt = '{ "verdicts": { "x": ';
    seed(corrupt);
    await expect(getDatabase()).rejects.toThrow(/korrupt/);
    await expect(
      updateDb((db) => {
        db.verdicts.y = item('y');
      })
    ).rejects.toThrow(/korrupt/);
    expect(fs.readFileSync(file(), 'utf-8')).toBe(corrupt);
  });

  it('skriver .bak af forrige version og efterlader ingen temp-filer', async () => {
    seed(empty);
    await updateDb((db) => {
      db.verdicts.a = item('a');
    });
    expect(fs.readFileSync(file().replace(/\.json$/, '.bak.json'), 'utf-8')).toBe(empty);
    expect(fs.readdirSync(path.join(dir, 'data')).sort()).toEqual(['insiderops-db.bak.json', 'insiderops-db.json']);
  });

  it('manglende fil (første kørsel) giver tom DB, som oprettes ved første skrivning', async () => {
    expect(await getDatabase()).toEqual({ verdicts: {}, scanHistory: {}, paperPortfolio: {} });
    await updateDb((db) => {
      db.verdicts.a = item('a');
    });
    expect(fs.existsSync(file())).toBe(true);
  });

  it('rename prøves igen ved EPERM (Windows-lås) og lykkes', async () => {
    seed(empty);
    const realRename = fs.promises.rename;
    let calls = 0;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (a, b) => {
      if (++calls <= 2) throw Object.assign(new Error('låst'), { code: 'EPERM' });
      return realRename(a, b);
    });
    await updateDb((db) => {
      db.verdicts.a = item('a');
    });
    expect(calls).toBe(3);
    expect(Object.keys(JSON.parse(fs.readFileSync(file(), 'utf-8')).verdicts)).toEqual(['a']);
  });

  it('rename der bliver ved med at fejle, kaster efter retries og efterlader ingen temp-fil', async () => {
    seed(empty);
    const spy = vi.spyOn(fs.promises, 'rename').mockRejectedValue(Object.assign(new Error('låst'), { code: 'EBUSY' }));
    await expect(
      updateDb((db) => {
        db.verdicts.a = item('a');
      })
    ).rejects.toThrow(/låst/);
    expect(spy).toHaveBeenCalledTimes(10);
    expect(fs.readdirSync(path.join(dir, 'data')).some((f) => f.includes('.tmp.'))).toBe(false);
    expect(fs.readFileSync(file(), 'utf-8')).toBe(empty);
  }, 10_000);

  it('isMockEntity matcher kun id-præfikset "mock-"', () => {
    expect(isMockEntity('mock-cfo-cluster-buy')).toBe(true);
    expect(isMockEntity('pos-rapp-cfo')).toBe(false);
    expect(isMockEntity('exec-buy-RAPP-2026-10-21-5500-143550')).toBe(false);
  });
});
