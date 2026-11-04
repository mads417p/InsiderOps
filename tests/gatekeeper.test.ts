import { describe, expect, it } from 'vitest';
import { GATEKEEPER_CHUNK_SIZE, lowThinkingConfig, parseGatekeeperBatch } from '@/lib/gemini-gatekeeper';

describe('Gemini-batch (audit 6h)', () => {
  it('afskåret JSON kaster en tydelig fejl i stedet for at blive til heuristik i stilhed', () => {
    expect(() => parseGatekeeperBatch('[{"id":"a","quickReasoning":"Ubeh')).toThrow(/ikke gyldig JSON/);
    expect(() => parseGatekeeperBatch('{"id":"a"}')).toThrow(/JSON-array/);
    expect(parseGatekeeperBatch('[{"id":"a","geminiPreScore":80}]')[0].geminiPreScore).toBe(80);
  });

  it('små chunks og lav thinking pr. modelfamilie', () => {
    expect(GATEKEEPER_CHUNK_SIZE).toBeLessThanOrEqual(5);
    expect(lowThinkingConfig('gemini-2.5-flash')).toEqual({ thinkingBudget: 0 });
    expect(lowThinkingConfig('gemini-3-flash-preview')).toEqual({ thinkingLevel: 'LOW' });
  });
});
