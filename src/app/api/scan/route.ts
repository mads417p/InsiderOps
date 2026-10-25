import { NextResponse } from 'next/server';
import {
  getMockTransactions,
  fetchLiveSecForm4s,
  scanTickerSecForm4s,
  fetchExecutiveAndClusterBuys,
} from '@/lib/sec-scanner';
import { fetchNordicInsiderTransactions } from '@/lib/nordic-scanner';
import { evaluateBatchWithGatekeeper } from '@/lib/gemini-gatekeeper';
import { enrichTransactionWithMarketData } from '@/lib/market-enricher';
import { saveScan, getLatestScan } from '@/lib/db';
import { InsiderTransaction } from '@/types/insider';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const transactions: InsiderTransaction[] = body.transactions || [];

    const enriched = await Promise.all(
      transactions.map((tx) => enrichTransactionWithMarketData({ ...tx }))
    );

    return NextResponse.json({
      success: true,
      count: enriched.length,
      transactions: enriched,
    });
  } catch (error: unknown) {
    console.error('Fejl i POST /api/scan:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Kunne ikke opdatere live markedskurser',
      },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const source = searchParams.get('source') || 'mock';
    const ticker = searchParams.get('ticker')?.trim().toUpperCase();
    const sourceKey = ticker ? `ticker:${ticker}` : source;

    let transactions: InsiderTransaction[] = [];
    try {
      if (ticker && ticker.length > 0) {
        transactions = await scanTickerSecForm4s(ticker);
      } else if (source === 'nordic') {
        transactions = await fetchNordicInsiderTransactions();
      } else if (source === 'csuite') {
        transactions = await fetchExecutiveAndClusterBuys(25);
      } else if (source === 'live') {
        transactions = await fetchLiveSecForm4s(20);
      } else {
        transactions = getMockTransactions();
      }
    } catch (fetchErr) {
      console.warn(`Fejl ved hentning af transaktioner for ${sourceKey}:`, fetchErr);
    }

    let sortedEvaluations: Array<{
      transaction: InsiderTransaction;
      result: import('@/types/insider').GatekeeperResult;
    }> = [];

    if (transactions.length > 0) {
      const evaluations = await evaluateBatchWithGatekeeper(transactions);

      // Sorter: Handler med bestået hard filter og højest geminiPreScore øverst, afviste nederst
      sortedEvaluations = [...evaluations].sort((a, b) => {
        if (a.result.passedHardFilter && !b.result.passedHardFilter) return -1;
        if (!a.result.passedHardFilter && b.result.passedHardFilter) return 1;
        return b.result.geminiPreScore - a.result.geminiPreScore;
      });

      // Gem scanningen i den server-side database
      try {
        await saveScan(sourceKey, sortedEvaluations);
      } catch (dbErr) {
        console.warn('Kunne ikke gemme scanning i database:', dbErr);
      }
    } else {
      // Hvis live scan er tom eller fejlede, tjek seneste gemte scanning i databasen
      const cached = await getLatestScan(sourceKey);
      if (cached && cached.length > 0) {
        sortedEvaluations = cached;
      }
    }

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
