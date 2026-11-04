import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_GATEKEEPER_SYSTEM,
  gatekeeperCostUsd,
  parseClaudeGatekeeperMessage,
  type GatekeeperClient,
} from '@/lib/claude-gatekeeper';
import { evaluateBatchWithGatekeeper } from '@/lib/gemini-gatekeeper';
import { isModelScore } from '@/lib/ui-labels';
import type { InsiderTransaction } from '@/types/insider';

let n = 0;
const tx = (over: Partial<InsiderTransaction> = {}): InsiderTransaction => ({
  id: `t${++n}`,
  ticker: `T${n}`,
  companyName: 'Acme Corp',
  insiderName: 'Smith John',
  insiderTitle: 'CFO',
  transactionCode: 'P',
  shares: 10_000,
  pricePerShare: 20,
  totalValueUsd: 200_000,
  tradeDate: '2026-10-20',
  isClusterBuy: false,
  secFilingUrl: 'https://www.sec.gov',
  ...over,
});

const msg = (items: unknown, stop_reason = 'end_turn') => ({
  stop_reason,
  content: [{ type: 'thinking' }, { type: 'text', text: JSON.stringify({ items }) }],
  usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 700 },
});

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  score: 80,
  asymmetrySignal: 'HIGH',
  begrundelse: 'CFO køber stort efter kursfald.',
  brugteFelter: ['insiderTitle', 'totalValueUsd', 'opfundetFelt'],
  ...over,
});

describe('Claude-gatekeeper: validering i kode', () => {
  it('gyldigt svar → scoreSource claude, signal fra scoren, kun kendte brugte felter', () => {
    const a = tx();
    const { results, invalid } = parseClaudeGatekeeperMessage(msg([item(a.id, { asymmetrySignal: 'medium' })]), [a]);
    expect(invalid).toEqual([]);
    const r = results.get(a.id)!;
    expect(r.scoreSource).toBe('claude');
    expect(r.geminiPreScore).toBe(80);
    expect(r.asymmetrySignal).toBe('HIGH'); // båndet følger scoren, ikke modellens etiket
    expect(r.usedFields).toEqual(['insiderTitle', 'totalValueUsd']);
  });

  it('score uden for interval clampes', () => {
    const a = tx();
    const b = tx();
    const { results } = parseClaudeGatekeeperMessage(msg([item(a.id, { score: 140 }), item(b.id, { score: -5 })]), [a, b]);
    expect(results.get(a.id)!.geminiPreScore).toBe(100);
    expect(results.get(b.id)!.geminiPreScore).toBe(0);
    expect(results.get(b.id)!.asymmetrySignal).toBe('NOISE');
  });

  it('forkert enum, fremmed id og tom begrundelse afvises pr. element', () => {
    const a = tx();
    const b = tx();
    const c = tx();
    const { results, invalid } = parseClaudeGatekeeperMessage(
      msg([item(a.id, { asymmetrySignal: 'SUPER' }), item('fremmed'), item(b.id, { begrundelse: '  ' }), item(c.id)]),
      [a, b, c]
    );
    expect([...results.keys()]).toEqual([c.id]);
    expect(invalid).toHaveLength(3);
  });

  it('10b5-1-reglen håndhæves i kode', () => {
    const a = tx({ is10b51Plan: true });
    const { results } = parseClaudeGatekeeperMessage(msg([item(a.id, { score: 90 })]), [a]);
    expect(results.get(a.id)!.geminiPreScore).toBe(19);
    expect(results.get(a.id)!.asymmetrySignal).toBe('NOISE');
  });

  it('afskåret eller afvist svar kaster', () => {
    const a = tx();
    expect(() => parseClaudeGatekeeperMessage(msg([item(a.id)], 'max_tokens'), [a])).toThrow(/afskåret/);
    expect(() => parseClaudeGatekeeperMessage(msg([item(a.id)], 'refusal'), [a])).toThrow(/afvist/);
  });

  it('system-prompten er over Haikus cache-minimum (512 tokens ≈ 2.000 tegn) og uden datoer', () => {
    expect(CLAUDE_GATEKEEPER_SYSTEM.length).toBeGreaterThan(2400);
    expect(CLAUDE_GATEKEEPER_SYSTEM).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('pris regnes med Haiku-takster; ukendt model giver ingen pris', () => {
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 1_000_000 };
    expect(gatekeeperCostUsd({ ...u, model: 'claude-haiku-5-5' })).toBeCloseTo(0.61, 6);
    expect(gatekeeperCostUsd({ ...u, model: 'claude-sonnet-5-5' })).toBeUndefined();
  });
});

describe('evaluateBatchWithGatekeeper med Claude', () => {
  beforeEach(() => {
    vi.stubEnv('GATEKEEPER_PROVIDER', '');
    vi.stubEnv('CLAUDE_GATEKEEPER_MODEL', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const fakeClient = (reply: (ids: string[]) => ReturnType<typeof msg>) => {
    const create = vi.fn(async (params: { messages: Array<{ content: unknown }> }) => {
      const ids = [...String(params.messages[0].content).matchAll(/"id": "([^"]+)"/g)].map((m) => m[1]);
      return reply(ids);
    });
    return { client: { messages: { create } } as unknown as GatekeeperClient, create };
  };

  it('22 kandidater → 3 kald, alle claude, usage og pris summeret; første chunk går alene', async () => {
    const txs = Array.from({ length: 22 }, () => tx());
    const { client, create } = fakeClient((ids) => msg(ids.map((id) => item(id))));
    const { evaluations, usage } = await evaluateBatchWithGatekeeper(txs, { claudeClient: client });
    expect(create).toHaveBeenCalledTimes(3);
    expect(evaluations.every((e) => e.result.scoreSource === 'claude')).toBe(true);
    expect(usage).toMatchObject({ provider: 'claude', model: 'claude-haiku-5-5', calls: 3, inputTokens: 300, cacheReadInputTokens: 2100, heuristicCount: 0 });
    expect(usage.costUsd).toBeGreaterThan(0);
    const firstParams = create.mock.calls[0][0] as unknown as { system: Array<{ cache_control?: unknown }> };
    expect(firstParams.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('afskåret chunk → heuristik med mærke, tælles som afskåret, starter ikke auto-køen', async () => {
    const txs = [tx(), tx()];
    const { client } = fakeClient((ids) => msg(ids.map((id) => item(id)), 'max_tokens'));
    const { evaluations, usage } = await evaluateBatchWithGatekeeper(txs, { claudeClient: client });
    expect(evaluations.map((e) => e.result.scoreSource)).toEqual(['heuristik', 'heuristik']);
    expect(evaluations[0].result.quickReasoning).toMatch(/^Heuristik \(ingen model-vurdering\)/);
    expect(usage).toMatchObject({ provider: 'heuristik', truncatedChunks: 1, failedChunks: 1, heuristicCount: 2 });
    expect(evaluations.some((e) => isModelScore(e.result))).toBe(false);
    expect(console.error).toHaveBeenCalled();
  });

  it('API-fejl → heuristik; manglende nøgle → heuristik uden kald', async () => {
    const create = vi.fn().mockRejectedValue(new Error('529 overloaded'));
    const res = await evaluateBatchWithGatekeeper([tx()], { claudeClient: { messages: { create } } as unknown as GatekeeperClient });
    expect(res.evaluations[0].result.scoreSource).toBe('heuristik');

    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const create2 = vi.fn();
    const res2 = await evaluateBatchWithGatekeeper([tx()], { claudeClient: { messages: { create: create2 } } as unknown as GatekeeperClient });
    expect(create2).not.toHaveBeenCalled();
    expect(res2.usage.provider).toBe('heuristik');
  });

  it('hard-filter-afviste rækker koster intet kald', async () => {
    const { client, create } = fakeClient((ids) => msg(ids.map((id) => item(id))));
    const { evaluations } = await evaluateBatchWithGatekeeper([tx({ transactionCode: 'S' })], { claudeClient: client });
    expect(create).not.toHaveBeenCalled();
    expect(evaluations[0].result.passedHardFilter).toBe(false);
  });
});

describe('isModelScore (auto-køen)', () => {
  it('kun claude og gemini; heuristik og gamle scans uden scoreSource giver false', () => {
    expect(isModelScore({ scoreSource: 'claude' })).toBe(true);
    expect(isModelScore({ scoreSource: 'gemini' })).toBe(true);
    expect(isModelScore({ scoreSource: 'heuristik' })).toBe(false);
    expect(isModelScore({} as never)).toBe(false);
  });
});
