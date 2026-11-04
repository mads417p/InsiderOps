/**
 * Fælles klient til alle kald mod SEC (www.sec.gov og data.sec.gov).
 * - SEC fair access: højst 8 requests/sek. på tværs af hele processen, backoff ved 429.
 * - SEC kræver en User-Agent med navn og mail. Den skal stå i SEC_USER_AGENT (.env.local); der er ingen indbygget.
 * - Kun https og kun SEC's egne hostnames – URL'er fra klienten kan ikke bruges til SSRF.
 */

const SEC_HOSTS = ['www.sec.gov', 'data.sec.gov'];
const MIN_INTERVAL_MS = 125; // 8 req/s
const MAX_ATTEMPTS = 4;

/** Returnerer SEC_USER_AGENT eller kaster – vi sender aldrig en opfundet eller andens identitet til SEC. */
export function secUserAgent(): string {
  const ua = process.env.SEC_USER_AGENT?.trim();
  if (!ua) {
    throw new Error('SEC_USER_AGENT mangler i .env.local (SEC kræver fx "InsiderOps/1.0 (navn@domæne.dk)")');
  }
  return ua;
}

/** Validerer, at en URL er https og peger på et tilladt SEC-hostname. Kaster ellers. */
export function assertSecUrl(url: string, allowedHosts: string[] = SEC_HOSTS): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Ugyldig SEC-URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' || !allowedHosts.includes(parsed.hostname)) {
    throw new Error(`Afvist URL (kun https://${allowedHosts.join(' / ')}): ${url}`);
  }
  return parsed;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ponytail: kø på globalThis (som db.ts), så Next' route-bundles deler grænsen. Dækker én proces.
const g = globalThis as typeof globalThis & { __secQueue?: Promise<unknown>; __secLastStart?: number };

/** Venter, til der er gået mindst MIN_INTERVAL_MS siden forrige SEC-kald startede. */
export function secThrottle(): Promise<void> {
  const run = (g.__secQueue ?? Promise.resolve()).then(async () => {
    const wait = (g.__secLastStart ?? 0) + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    g.__secLastStart = Date.now();
  });
  g.__secQueue = run.catch(() => undefined);
  return run;
}

/**
 * fetch mod SEC med rate-limit, påkrævet User-Agent, timeout og backoff ved 429 (Retry-After respekteres).
 * Svar med andre statuskoder returneres uændret – kalderen afgør, om det er en fejl.
 */
export async function secFetch(
  url: string,
  opts: { accept?: string; timeoutMs?: number; allowedHosts?: string[] } = {}
): Promise<Response> {
  assertSecUrl(url, opts.allowedHosts);
  const userAgent = secUserAgent();

  for (let attempt = 1; ; attempt++) {
    await secThrottle();
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, Accept: opts.accept ?? '*/*' },
      cache: 'no-store', // companyfacts kan være > 2 MB – for stort til Next' fetch-cache
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (res.status !== 429 || attempt >= MAX_ATTEMPTS) return res;

    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
    console.warn(`SEC svarede 429 på ${url} – venter ${waitMs} ms (forsøg ${attempt}/${MAX_ATTEMPTS})`);
    await sleep(Math.min(waitMs, 10_000));
  }
}
