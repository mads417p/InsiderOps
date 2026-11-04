import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSecUrl, secFetch, secThrottle, secUserAgent } from '@/lib/sec-client';
import { fetchSecForm4Footnotes } from '@/lib/sec-scanner';

beforeEach(() => {
  vi.stubEnv('SEC_USER_AGENT', 'InsiderOps-test (test@example.com)');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('SEC-klient', () => {
  it('SSRF: kun https og SEC-hostnames', () => {
    expect(() => assertSecUrl('http://169.254.169.254/?sec.gov')).toThrow(/Afvist/);
    expect(() => assertSecUrl('https://evil.com/sec.gov')).toThrow(/Afvist/);
    expect(() => assertSecUrl('https://www.sec.gov.evil.com/x')).toThrow(/Afvist/);
    expect(() => assertSecUrl('http://www.sec.gov/Archives/x.xml')).toThrow(/Afvist/);
    expect(() => assertSecUrl('ikke en url')).toThrow(/Ugyldig/);
    expect(assertSecUrl('https://www.sec.gov/Archives/x.xml').hostname).toBe('www.sec.gov');
    expect(() => assertSecUrl('https://data.sec.gov/api/x', ['www.sec.gov'])).toThrow(/Afvist/);
  });

  it('fetchSecForm4Footnotes afviser en klient-URL uden for www.sec.gov uden at kalde fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(fetchSecForm4Footnotes('http://169.254.169.254/?sec.gov')).rejects.toThrow(/Afvist/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('manglende SEC_USER_AGENT kaster (ingen indbygget mail)', () => {
    vi.stubEnv('SEC_USER_AGENT', '');
    expect(() => secUserAgent()).toThrow(/SEC_USER_AGENT mangler/);
  });

  it('limiteren holder mindst 125 ms mellem kald (8 req/s)', async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const calls = Array.from({ length: 4 }, () => secThrottle().then(() => starts.push(Date.now())));
    await vi.runAllTimersAsync();
    await Promise.all(calls);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(125);
  });

  it('429 giver backoff med Retry-After og et nyt forsøg', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const p = secFetch('https://www.sec.gov/files/company_tickers.json');
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers['User-Agent']).toBe('InsiderOps-test (test@example.com)');
  });
});
