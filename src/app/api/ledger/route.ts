import { connection, NextResponse } from 'next/server';
import { listOutcomes, listSignals } from '@/lib/ledger';
import { ledgerStats, PREREG } from '@/lib/ledger-stats';
import { costsFileSha256, loadCosts, type CostsConfig } from '@/lib/costs';
import { computeMissingOutcomes } from '@/lib/outcomes';

/** Måling-fanen: statistik over signal-ledgeren (ingen live-kald). */
export async function GET() {
  await connection(); // synkron SQLite-læsning må ikke prerenderes (cacheComponents)
  try {
    let costs: CostsConfig | null = null;
    let costsError: string | null = null;
    let costsSha256: string | null = null;
    try {
      costs = loadCosts();
      costsSha256 = costsFileSha256();
    } catch (e) {
      costsError = `config/costs.json kunne ikke læses: ${e instanceof Error ? e.message : String(e)}`;
    }
    const stats = ledgerStats({ signals: listSignals(), outcomes: listOutcomes(), costs, now: new Date() });
    // Frosne omkostninger (prereg): afviger filen, vises en advarsel; tallene beregnes stadig med filens satser.
    const costsMatchPrereg = costs?.version === PREREG.costsVersion && costsSha256 === PREREG.costsSha256;
    return NextResponse.json({ success: true, ...stats, costsTodo: costs?.TODO ?? null, costsError, costsSha256, costsMatchPrereg });
  } catch (error) {
    console.error('Fejl i GET /api/ledger:', error);
    return NextResponse.json({ success: false, error: `Ledgeren kunne ikke læses: ${(error as Error).message}` }, { status: 500 });
  }
}

/** Knappen "Beregn udfald": samme job som `npm run outcomes`. */
export async function POST() {
  try {
    const result = await computeMissingOutcomes();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error('Fejl i POST /api/ledger:', error);
    return NextResponse.json({ success: false, error: `Udfaldsjobbet fejlede: ${(error as Error).message}` }, { status: 500 });
  }
}
