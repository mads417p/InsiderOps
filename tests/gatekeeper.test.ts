import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GATEKEEPER_CHUNK_SIZE,
  geminiRetryDelaySec,
  lowThinkingConfig,
  parseGatekeeperBatch,
  withGeminiQuotaRetry,
} from '@/lib/gemini-gatekeeper';

afterEach(() => vi.useRealTimers());

// Uddrag af et rigtigt Free Tier-svar (4.11.2026), forkortet.
const quotaErr = (sec: number) =>
  new Error(`{"error":{"code":429,"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"${sec}s"}]}}`);

describe('Gemini-batch (audit 6h)', () => {
  it('afskåret JSON kaster en tydelig fejl i stedet for at blive til heuristik i stilhed', () => {
    expect(() => parseGatekeeperBatch('[{"id":"a","quickReasoning":"Ubeh')).toThrow(/ikke gyldig JSON/);
    expect(() => parseGatekeeperBatch('{"id":"a"}')).toThrow(/JSON-array/);
    expect(parseGatekeeperBatch('[{"id":"a","geminiPreScore":80}]')[0].geminiPreScore).toBe(80);
  });

  it('chunk-størrelse og lav thinking pr. modelfamilie', () => {
    expect(GATEKEEPER_CHUNK_SIZE).toBeLessThan(12); // 12 blev afskåret
    expect(lowThinkingConfig('gemini-2.5-flash')).toEqual({ thinkingBudget: 0 });
    expect(lowThinkingConfig('gemini-3-flash-preview')).toEqual({ thinkingLevel: 'LOW' });
  });

  it('kvotefejl genkendes, og retryDelay læses', () => {
    expect(geminiRetryDelaySec(quotaErr(14))).toBe(14);
    expect(geminiRetryDelaySec(new Error('Unterminated string in JSON'))).toBeUndefined();
  });

  it('minutgrænse (kort ventetid): venter og prøver igen', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValueOnce(quotaErr(14)).mockResolvedValueOnce('ok');
    const onExhausted = vi.fn();
    const p = withGeminiQuotaRetry(fn, onExhausted);
    await vi.runAllTimersAsync();
    expect(await p).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('dagsgrænse (lang ventetid): ingen nye kald, kvoten markeres som opbrugt', async () => {
    const fn = vi.fn().mockRejectedValue(quotaErr(41234));
    const onExhausted = vi.fn();
    await expect(withGeminiQuotaRetry(fn, onExhausted)).rejects.toThrow(/kvoten er opbrugt/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });
});
