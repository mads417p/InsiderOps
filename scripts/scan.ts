/**
 * Planlagt scan (fase 9): samme scan som "Scan Nu" i UI (kilde unified) – uden at dev-serveren skal køre.
 * Kører dev-serveren alligevel, sendes scannen til den, så kun én proces skriver i JSON-DB'en
 * (skrivekøen i db.ts dækker ikke to processer). Ellers køres route-handleren her i processen.
 *
 * Koster penge: gatekeeperen (Claude Haiku) og Nordic-udtrækket (Gemini) kaldes – prisen logges.
 * Rådet kører aldrig herfra.
 *
 * Kørsel (fra repo-roden): npm run scan     ·  planlagt: scripts/ops/run-job.ps1 -Job scan
 */
import { existsSync } from 'node:fs';

const DEV = 'http://127.0.0.1:3000';

type ScanBody = {
  success: boolean;
  error?: string;
  count?: number;
  scannedAt?: string;
  stale?: boolean;
  errors?: Array<{ source: string; error: string }>;
  gatekeeperUsage?: { provider: string; model?: string; calls: number; costUsd?: number } | null;
  ledger?: { inserted: number; seen: number; scored: number } | { error: string } | null;
  autoQueue?: { rule: string; ids: string[] };
  rejectedCount?: number;
};

async function devServerUp(): Promise<boolean> {
  try {
    // 15 s: første kald til en kold dev-server kompilerer routen. Er serveren nede, fejler det med det samme.
    return (await fetch(`${DEV}/api/scan?latest=1`, { signal: AbortSignal.timeout(15_000) })).ok;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');

  let body: ScanBody;
  if (await devServerUp()) {
    console.log('Dev-serveren kører – scannen sendes til den.');
    body = (await (await fetch(`${DEV}/api/scan`)).json()) as ScanBody;
  } else {
    console.log('Dev-serveren kører ikke – scanner i denne proces.');
    const { GET } = await import('../src/app/api/scan/route');
    body = (await (await GET(new Request('http://localhost/api/scan'))).json()) as ScanBody;
  }

  if (!body.success) {
    console.error(`Scan fejlede: ${body.error ?? 'ukendt fejl'}`);
    return 1;
  }
  const g = body.gatekeeperUsage;
  console.log(
    `Scan ${body.scannedAt}${body.stale ? ' (FORÆLDET – alle kilder fejlede, viser seneste gemte)' : ''}: ` +
      `${body.count} rækker, ${body.rejectedCount ?? 0} afvist`
  );
  if (g) {
    console.log(`Gatekeeper ${g.provider}${g.model ? ` (${g.model})` : ''}: ${g.calls} kald, pris ${g.costUsd !== undefined ? `$${g.costUsd.toFixed(4)}` : 'ukendt'}`);
  }
  if (body.ledger) console.log(`Signal-ledger: ${JSON.stringify(body.ledger)}`);
  if (body.autoQueue) console.log(`Auto-kø (${body.autoQueue.rule}): ${body.autoQueue.ids.length} – rådet startes kun ved klik`);
  for (const e of body.errors ?? []) console.error(`Kilde fejlede: ${e.source}: ${e.error}`);
  return body.stale ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Scan-jobbet fejlede:', err);
    process.exit(1);
  });
