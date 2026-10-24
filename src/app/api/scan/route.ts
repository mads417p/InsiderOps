import { NextResponse } from 'next/server';
import { getMockTransactions, fetchLiveSecForm4s, scanTickerSecForm4s } from '@/lib/sec-scanner';
import { fetchNordicInsiderTransactions } from '@/lib/nordic-scanner';
import { evaluateBatchWithGatekeeper } from '@/lib/gemini-gatekeeper';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const source = searchParams.get('source') || 'mock';
    const ticker = searchParams.get('ticker')?.trim().toUpperCase();

    let transactions;
    if (ticker && ticker.length > 0) {
      transactions = await scanTickerSecForm4s(ticker);
    } else if (source === 'nordic') {
      transactions = await fetchNordicInsiderTransactions();
    } else if (source === 'live') {
      transactions = await fetchLiveSecForm4s(16);
    } else {
      transactions = getMockTransactions();
    }

    const evaluations = await evaluateBatchWithGatekeeper(transactions);

    // Sorter: Handler med bestået hard filter og højest geminiPreScore øverst, afviste nederst
    const sortedEvaluations = [...evaluations].sort((a, b) => {
      if (a.result.passedHardFilter && !b.result.passedHardFilter) return -1;
      if (!a.result.passedHardFilter && b.result.passedHardFilter) return 1;
      return b.result.geminiPreScore - a.result.geminiPreScore;
    });

    const geminiKey = process.env.GEMINI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;

    const apiKeysConfigured = {
      gemini: Boolean(geminiKey && geminiKey.trim() !== '' && !geminiKey.includes('your-')),
      anthropic: Boolean(
        anthropicKey &&
          anthropicKey.trim() !== '' &&
          !anthropicKey.includes('your-') &&
          anthropicKey !== 'placeholder'
      ),
    };

    return NextResponse.json({
      success: true,
      source: ticker ? `ticker:${ticker}` : source,
      ticker: ticker || null,
      apiKeysConfigured,
      count: sortedEvaluations.length,
      items: sortedEvaluations,
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
    console.error('Fejl i /api/scan:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Kunne ikke scanne og evaluere insider-transaktioner',
      },
      { status: 500 }
    );
  }
}
