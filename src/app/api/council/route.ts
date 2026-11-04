import { NextResponse } from 'next/server';
import { conveneCouncil, CouncilError } from '@/lib/claude-council';
import { fetchSecForm4Footnotes } from '@/lib/sec-scanner';
import { enrichTransactionWithMarketData } from '@/lib/market-enricher';
import { fetchVerifiedLiveQuote } from '@/lib/live-quote';
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
    const forceRefresh = Boolean(body.forceRefresh);

    if (!tx || !tx.ticker || !tx.insiderName) {
      return NextResponse.json(
        { success: false, error: 'Ugyldig transaktionsdata modtaget' },
        { status: 400 }
      );
    }

    // Tjek om der findes en tidligere afsagt dom for at gemme previousScore ved gen-vurdering
    let previousScore: number | undefined;
    try {
      const existingVerdicts = await getSavedVerdicts();
      const existingItem =
        existingVerdicts[tx.id] ||
        Object.values(existingVerdicts).find(
          (v) => v.transaction.ticker.toUpperCase() === tx.ticker.toUpperCase()
        );
      if (existingItem?.verdict?.asymmetryScore) {
        previousScore = existingItem.verdict.asymmetryScore;
      }
    } catch (dbReadErr) {
      console.warn('Kunne ikke læse eksisterende domme for previousScore:', dbReadErr);
    }

    // Ved forceRefresh eller manglende markedsdata: Hent spritnye live-kurser, ATR og teknisk kontekst
    if (forceRefresh || tx.currentMarketPrice === undefined || tx.recentPriceChange30dPct === undefined) {
      await enrichTransactionWithMarketData(tx);

      try {
        const liveQuote = await fetchVerifiedLiveQuote(tx.ticker);
        if (liveQuote && typeof liveQuote.price === 'number' && liveQuote.price > 0) {
          tx.currentMarketPrice = liveQuote.price;
          if (tx.pricePerShare > 0 && tx.transactionCode === 'P') {
            const diffPct = Number(
              (((liveQuote.price - tx.pricePerShare) / tx.pricePerShare) * 100).toFixed(2)
            );
            tx.returnSinceBuyPct = diffPct;
            tx.isTradingBelowInsiderPrice = liveQuote.price < tx.pricePerShare;
          }
        }
      } catch (liveQuoteErr) {
        console.warn('Kunne ikke hente frisk dual-feed live quote for', tx.ticker, liveQuoteErr);
      }
    }

    // Parallel hentning af Form 4 fodnoter, insider track record og fundamentale nøgletal / SEC balance
    const enrichmentTasks: Promise<unknown>[] = [];

    // 1. SEC EDGAR Form 4 juridiske fodnoter
    if (
      tx.secFilingUrl &&
      tx.secFilingUrl.startsWith('https://www.sec.gov/') &&
      !tx.contextNotes?.includes('SEC Form 4 Fodnoter')
    ) {
      enrichmentTasks.push(
        (async () => {
          try {
            const { footnotes, is10b51Plan } = await fetchSecForm4Footnotes(tx.secFilingUrl);
            // 10b5-1 afgøres af Form 4 selv: afkrydsningsfelt eller fodnote refereret fra købslinjerne.
            if (is10b51Plan !== undefined) tx.is10b51Plan = is10b51Plan;
            if (footnotes.length > 0) {
              tx.footnotesSummary = footnotes.join('\n\n');
              const footnoteSection = `SEC Form 4 Fodnoter (Det med småt):\n${tx.footnotesSummary}`;
              tx.contextNotes = tx.contextNotes
                ? `${tx.contextNotes}\n\n${footnoteSection}`
                : footnoteSection;
            }
          } catch (fnErr) {
            console.warn('Kunne ikke hente SEC fodnoter:', fnErr);
          }
        })()
      );
    }

    // 2. Historisk track record for insideren / ledelsen (hentes igen ved forceRefresh – gemte værdier kan være forældede)
    if (forceRefresh || !tx.trackRecord) {
      tx.trackRecord = undefined;
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

    // 3. Fundamentale nøgletal, SEC XBRL balance sheet, cash runway & short interest (igen ved forceRefresh)
    if (forceRefresh || !tx.fundamentals) {
      tx.fundamentals = undefined;
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

    // Fejler rådet, svares der med fejlstatus, og der gemmes intet.
    let verdict;
    try {
      verdict = await conveneCouncil(tx, judgeTier);
    } catch (councilErr) {
      if (councilErr instanceof CouncilError) {
        console.error(`Rådet fejlede for ${tx.ticker} (${councilErr.reason}):`, councilErr.message);
        return NextResponse.json(
          { success: false, error: councilErr.message, reason: councilErr.reason },
          { status: councilErr.reason === 'MISSING_API_KEY' ? 503 : 502 }
        );
      }
      throw councilErr;
    }

    const nowIso = new Date().toISOString();
    verdict.evaluatedAt = nowIso;
    // ponytail: insiderkurs som fallback for priceAtEvaluation hører til fase 3 (signal-ledger) – uændret her.
    verdict.priceAtEvaluation = tx.currentMarketPrice || tx.pricePerShare;
    if (typeof previousScore === 'number') {
      verdict.previousScore = previousScore;
    }

    // Gem dommen i data/insiderops-db.json (overskriver tidligere dom). Fejler skrivningen, ses det.
    try {
      await saveVerdict({ transaction: tx, verdict, savedAt: nowIso });
    } catch (dbErr) {
      console.error('Kunne ikke gemme dom i server-databasen:', dbErr);
      return NextResponse.json(
        { success: false, error: `Dommen blev afsagt, men kunne ikke gemmes: ${(dbErr as Error).message}` },
        { status: 500 }
      );
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
