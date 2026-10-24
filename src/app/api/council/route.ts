import { NextResponse } from 'next/server';
import { conveneCouncil } from '@/lib/claude-council';
import { InsiderTransaction } from '@/types/insider';


export async function POST(request: Request) {
  try {
    const body = await request.json();
    const tx = body.transaction as InsiderTransaction | undefined;

    if (!tx || !tx.ticker || !tx.insiderName) {
      return NextResponse.json(
        { success: false, error: 'Ugyldig transaktionsdata modtaget' },
        { status: 400 }
      );
    }

    const verdict = await conveneCouncil(tx);

    return NextResponse.json({
      success: true,
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
