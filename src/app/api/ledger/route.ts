import { connection, NextResponse } from 'next/server';
import { listOutcomes, listSignals } from '@/lib/ledger';
import { ledgerStats } from '@/lib/ledger-stats';
import { loadCosts, type CostsConfig } from '@/lib/costs';
import { computeMissingOutcomes } from '@/lib/outcomes';

/** Måling-fanen: statistik over signal-ledgeren (ingen live-kald). */
export async function GET() {
  await connection(); // synkron SQLite-læsning må ikke prerenderes (cacheComponents)
  try {
    let costs: CostsConfig | null = null;
    let costsError: string | null = null;
    try {
      costs = loadCosts();
    } catch (e) {
      costsError = `config/costs.json kunne ikke læses: ${e instanceof Error ? e.message : String(e)}`;
    }
    const stats = ledgerStats({ signals: listSignals(), outcomes: listOutcomes(), costs, now: new Date() });
    return NextResponse.json({ success: true, ...stats, costsTodo: costs?.TODO ?? null, costsError });
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
