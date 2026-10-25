import { NextResponse } from 'next/server';
import { conveneCouncil } from '@/lib/claude-council';
import { fetchSecForm4Footnotes } from '@/lib/sec-scanner';
import { enrichTransactionWithMarketData } from '@/lib/market-enricher';
import { InsiderTransaction } from '@/types/insider';

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

    // Hvis transaktionen stammer fra en SEC EDGAR filing og vi ikke allerede har udtrukket fodnoter,
    // hent det rå Form 4 XML og udtræk de juridiske fodnoter ("det med småt")
    if (
      tx.secFilingUrl &&
      tx.secFilingUrl.includes('sec.gov') &&
      !tx.contextNotes?.includes('SEC Form 4 Fodnoter')
    ) {
      const footnotes = await fetchSecForm4Footnotes(tx.secFilingUrl);
      if (footnotes.length > 0) {
        const footnoteSection = `SEC Form 4 Fodnoter (Det med småt):\n${footnotes.join('\n\n')}`;
        tx.contextNotes = tx.contextNotes
          ? `${tx.contextNotes}\n\n${footnoteSection}`
          : footnoteSection;
      }
    }

    const verdict = await conveneCouncil(tx, judgeTier);

    return NextResponse.json({
      success: true,
      judgeTier,
      verdict,
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
