import { NextResponse } from 'next/server';
import { getMockTransactions, fetchLiveSecForm4s } from '@/lib/sec-scanner';
import { evaluateBatchWithGatekeeper } from '@/lib/gemini-gatekeeper';


export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const source = searchParams.get('source') || 'mock';

    const transactions =
      source === 'live'
        ? await fetchLiveSecForm4s(12)
        : getMockTransactions();

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
      source,
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
