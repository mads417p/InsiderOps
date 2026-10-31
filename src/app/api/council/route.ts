import { NextResponse } from 'next/server';
import { conveneCouncil } from '@/lib/claude-council';
import { fetchSecForm4Footnotes } from '@/lib/sec-scanner';
import { enrichTransactionWithMarketData } from '@/lib/market-enricher';
import { fetchInsiderTrackRecord } from '@/lib/track-record';
import { fetchCompanyFundamentals } from '@/lib/fundamentals';
import { getSavedVerdicts, saveVerdict, deleteVerdict } from '@/lib/db';
import { InsiderTransaction } from '@/types/insider';

export async function GET() {
  try {
    const verdicts = await getSavedVerdicts();
    const count = Object.keys(verdicts).length;
    return NextResponse.json({
      success: true,
      count,
      verdicts,
    });
  } catch (error) {
    console.error('Fejl i GET /api/council:', error);
    return NextResponse.json(
      { success: false, error: 'Kunne ikke hente gemte domme fra server-databasen' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json(
        { success: false, error: 'Mangler id parameter' },
        { status: 400 }
      );
    }
    const deleted = await deleteVerdict(id);
    return NextResponse.json({
      success: true,
      deleted,
      id,
    });
  } catch (error) {
    console.error('Fejl i DELETE /api/council:', error);
    return NextResponse.json(
      { success: false, error: 'Kunne ikke slette dom fra databasen' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const tx = body.transaction as InsiderTransaction | undefined;
    const judgeTier = (body.judgeTier === 'sonnet' ? 'sonnet' : 'opus') as 'opus' | 'sonnet';

    if (!tx || !tx.ticker || !tx.insiderName) {
      return NextResponse.json(
        { success: false, error: 'Ugyldig transaktionsdata modtaget' },
        { status: 400 }
      );
    }

    // Sikr at transaktionen har opdaterede markedsdata (aktuel kurs, discount, 30d kursændring)
    if (tx.currentMarketPrice === undefined || tx.recentPriceChange30dPct === undefined) {
      await enrichTransactionWithMarketData(tx);
    }

    // Parallel hentning af Form 4 fodnoter, insider track record og fundamentale nøgletal / SEC balance
    const enrichmentTasks: Promise<unknown>[] = [];

    // 1. SEC EDGAR Form 4 juridiske fodnoter
    if (
      tx.secFilingUrl &&
      tx.secFilingUrl.includes('sec.gov') &&
      !tx.contextNotes?.includes('SEC Form 4 Fodnoter')
    ) {
      enrichmentTasks.push(
        (async () => {
          try {
            const footnotes = await fetchSecForm4Footnotes(tx.secFilingUrl);
            if (footnotes.length > 0) {
              tx.footnotesSummary = footnotes.join('\n\n');
              const footnoteSection = `SEC Form 4 Fodnoter (Det med småt):\n${tx.footnotesSummary}`;
              tx.contextNotes = tx.contextNotes
                ? `${tx.contextNotes}\n\n${footnoteSection}`
                : footnoteSection;

              // Tjek om fodnoterne nævner Rule 10b5-1 automatisk handelsplan
              if (/10b5-1|rule 10b5-1|pre-arranged|automatic purchase|trading plan/i.test(tx.footnotesSummary)) {
                tx.is10b51Plan = true;
              }
            }
          } catch (fnErr) {
            console.warn('Kunne ikke hente SEC fodnoter:', fnErr);
          }
        })()
      );
    }

    // 2. Historisk track record for insideren / ledelsen
    if (!tx.trackRecord) {
      enrichmentTasks.push(
        (async () => {
          try {
            tx.trackRecord = await fetchInsiderTrackRecord(tx);
          } catch (trErr) {
            console.warn('Kunne ikke hente insider track record:', trErr);
          }
        })()
      );
    }

    // 3. Fundamentale nøgletal, SEC XBRL balance sheet, cash runway & short interest
    if (!tx.fundamentals) {
      enrichmentTasks.push(
        (async () => {
          try {
            tx.fundamentals = await fetchCompanyFundamentals(tx);
          } catch (fundErr) {
            console.warn('Kunne ikke hente company fundamentals:', fundErr);
          }
        })()
      );
    }

    if (enrichmentTasks.length > 0) {
      await Promise.all(enrichmentTasks);
    }

    const verdict = await conveneCouncil(tx, judgeTier);

    // Gem automatisk dommen i server-databasen data/insiderops-db.json
    try {
      await saveVerdict({
        transaction: tx,
        verdict,
        savedAt: new Date().toISOString(),
      });
    } catch (dbErr) {
      console.warn('Kunne ikke gemme dom i server-databasen:', dbErr);
    }

    return NextResponse.json({
      success: true,
      judgeTier,
      verdict,
      transaction: tx,
    });
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'digest' in error &&
      (error as { digest?: string }).digest === 'NEXT_PRERENDER_INTERRUPTED'
    ) {
      throw error;
    }
    console.error('Fejl i /api/council:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Kunne ikke samle The Council for den angivne transaktion',
      },
      { status: 500 }
    );
  }
}
