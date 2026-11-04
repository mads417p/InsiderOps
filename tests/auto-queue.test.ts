import { afterEach, describe, expect, it, vi } from 'vitest';
import { autoQueueLabel, autoQueueRule, selectAutoQueue } from '@/lib/auto-queue';
import { claudeCostUsd } from '@/lib/claude-gatekeeper';
import { signalIdFor } from '@/lib/ledger';
import type { GatekeeperResult, InsiderTransaction } from '@/types/insider';

const item = (n: number, score: number, scoreSource: GatekeeperResult['scoreSource'] = 'claude') => ({
  transaction: {
    id: `oi-${n}-${n}`,
    accessionNo: String(n),
    ownerCik: String(n),
    ticker: `T${n}`,
    insiderName: `P ${n}`,
    isTradableInDK: true,
  } as InsiderTransaction,
  result: { passedHardFilter: true, geminiPreScore: score, scoreSource, asymmetrySignal: 'MEDIUM', quickReasoning: '' } as GatekeeperResult,
});

afterEach(() => vi.unstubAllEnvs());

describe('auto-kø: rangregel (fase 3, 3c)', () => {
  const rule = { topN: 3, minScore: 50 };

  it('de 3 højeste Claude-scorer ≥ 50; heuristik og under min tæller ikke', () => {
    const items = [item(1, 66), item(2, 62), item(3, 49), item(4, 80, 'heuristik'), item(5, 57), item(6, 55)];
    expect(selectAutoQueue(items, new Set(), rule)).toEqual(['oi-1-1', 'oi-2-2', 'oi-5-5']);
  });

  it('rang beregnes før dommede fjernes: en dømt top-række giver ikke plads til nr. 4', () => {
    const items = [item(1, 66), item(2, 62), item(5, 57), item(6, 55)];
    const judged = new Set([signalIdFor(items[0].transaction)]);
    expect(selectAutoQueue(items, judged, rule)).toEqual(['oi-2-2', 'oi-5-5']);
  });

  it('N og min kan sættes i env; ugyldige værdier giver standarden', () => {
    vi.stubEnv('AUTO_QUEUE_TOP_N', '5');
    vi.stubEnv('AUTO_QUEUE_MIN_SCORE', 'abc');
    expect(autoQueueRule()).toEqual({ topN: 5, minScore: 50 });
    expect(autoQueueLabel(autoQueueRule())).toBe('auto:rang-top5-min50');
  });
});

describe('claudeCostUsd', () => {
  it('Opus 5.5 og ukendt model', () => {
    const u = { inputTokens: 1_000_000, outputTokens: 100_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 1_000_000 };
    expect(claudeCostUsd('claude-opus-5-5', u)).toBe(4 + 2 + 0.2);
    expect(claudeCostUsd('ukendt', u)).toBeUndefined();
  });
});
