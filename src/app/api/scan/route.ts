import { NextResponse } from 'next/server';
import {
  getMockTransactions,
  fetchOpenInsiderBuys,
  fetchEdgarCurrentForm4s,
  scanTickerSecForm4s,
  buildScanRows,
  type RejectedRow,
} from '@/lib/sec-scanner';
import { fetchNordicInsiderTransactions } from '@/lib/nordic-scanner';
import { evaluateBatchWithGatekeeper } from '@/lib/gemini-gatekeeper';
import { anthropicKeyConfigured, gatekeeperModelLabel, gatekeeperProvider } from '@/lib/claude-gatekeeper';
import { enrichTransactionWithMarketData } from '@/lib/market-enricher';
import { saveScan, getLatestScan, getSavedVerdicts } from '@/lib/db';
import { autoQueueLabel, autoQueueRule, selectAutoQueue } from '@/lib/auto-queue';
import { recordSignals, signalIdFor } from '@/lib/ledger';
import { fetchLiveFxRates } from '@/lib/live-quote';
import { parseJson, scanPostSchema } from '@/lib/api-schemas';
import { GatekeeperResult, GatekeeperUsage, InsiderTransaction } from '@/types/insider';

export async function POST(request: Request) {
  try {
    const parsed = await parseJson(request, scanPostSchema);
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
    }
    // Kun markedsdata genberiges; intet gemmes, og ingen LLM-kald.
    const transactions = parsed.data.transactions as unknown as InsiderTransaction[];

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

function apiKeysConfigured() {
  const geminiKey = process.env.GEMINI_API_KEY;
  return {
    gemini: Boolean(geminiKey && geminiKey.trim() !== '' && !geminiKey.includes('your-')),
    anthropic: anthropicKeyConfigured(),
    gatekeeperProvider: gatekeeperProvider(),
    gatekeeperModel: gatekeeperModelLabel(),
  };
}

/** Rang-baseret auto-kø for de viste rækker (kun validerede domme tæller som "gemt dom"). */
async function autoQueueFor(items: Array<{ transaction: InsiderTransaction; result: GatekeeperResult }>) {
  const rule = autoQueueRule();
  const judged = new Set(
    Object.values(await getSavedVerdicts())
      .filter((v) => v.verdict?.validated === true)
      .map((v) => signalIdFor(v.transaction))
  );
  return { rule: autoQueueLabel(rule), topN: rule.topN, minScore: rule.minScore, ids: selectAutoQueue(items, judged, rule) };
}

type SourceTask = { name: string; run: () => Promise<InsiderTransaction[]> };

/**
 * Kilderne for en scan. Hver kilde hentes præcis én gang (OpenInsider højst én gang pr. screener),
 * og alle rækker går gennem samme pipeline (buildScanRows).
 */
function sourceTasks(source: string, ticker: string | undefined, sourceRejected: RejectedRow[]): SourceTask[] {
  const officer = { name: 'OpenInsider (C-suite)', run: () => fetchOpenInsiderBuys('officer', 25) };
  const general = { name: 'OpenInsider (alle insidere)', run: () => fetchOpenInsiderBuys('general', 25) };
  const edgar = { name: 'SEC EDGAR (seneste Form 4)', run: () => fetchEdgarCurrentForm4s(16) };
  const nordic = {
    name: 'Nasdaq Nordic (MAR art. 19)',
    run: async () => {
      const { transactions, rejected } = await fetchNordicInsiderTransactions();
      sourceRejected.push(...rejected); // meddelelser afvist allerede ved udtræk (tal/ISIN mangler i teksten osv.)
      return transactions;
    },
  };

  if (ticker) return [{ name: `SEC EDGAR (${ticker})`, run: () => scanTickerSecForm4s(ticker) }];
  if (source === 'nordic') return [nordic];
  if (source === 'csuite') return [officer, general];
  if (source === 'live') return [officer, general, edgar];
  if (source === 'mock') return [{ name: 'mock', run: async () => getMockTransactions() }];
  return [officer, general, edgar, nordic]; // unified
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sourceParam = searchParams.get('source');
    const source = sourceParam ? sourceParam.toLowerCase() : 'unified';
    const ticker = searchParams.get('ticker')?.trim().toUpperCase() || undefined;
    const sourceKey = ticker ? `ticker:${ticker}` : source;

    // Mock-data findes kun til udvikling og kun bag et eksplicit flag.
    if (source === 'mock' && process.env.INSIDEROPS_DEV_MOCKS !== '1') {
      return NextResponse.json(
        {
          success: false,
          error: 'Mock-data er slået fra. Sæt INSIDEROPS_DEV_MOCKS=1 i .env.local for at bruge ?source=mock under udvikling.',
        },
        { status: 400 }
      );
    }

    // ?latest=1: seneste gemte scan for kilden – ingen live-kald og ingen LLM (sidens indlæsning, fase 3).
    if (searchParams.get('latest') === '1') {
      const saved = await getLatestScan(sourceKey);
      return NextResponse.json({
        success: true,
        source: sourceKey,
        ticker: ticker || null,
        apiKeysConfigured: apiKeysConfigured(),
        saved: true,
        scannedAt: saved?.scannedAt ?? null,
        stale: false,
        errors: [],
        count: saved?.items.length ?? 0,
        items: saved?.items ?? [],
        gatekeeperUsage: null,
        rejectedCount: saved?.rejected?.length ?? 0,
        rejected: saved?.rejected ?? [],
        autoQueue: await autoQueueFor(saved?.items ?? []),
      });
    }

    // 1. Hent alle kilder parallelt. En fejlet kilde vises som fejl – aldrig som "ingen signaler".
    const sourceRejected: RejectedRow[] = [];
    const tasks = sourceTasks(source, ticker, sourceRejected);
    const settled = await Promise.allSettled(tasks.map((t) => t.run()));
    const errors: Array<{ source: string; error: string }> = [];
    const raw: InsiderTransaction[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') raw.push(...r.value);
      else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.error(`Scan-kilden "${tasks[i].name}" fejlede:`, msg);
        errors.push({ source: tasks[i].name, error: msg });
      }
    });

    // 2. Fælles pipeline: kode P → handelsdato/navn → dedup → berigelse → hard-filter → én række pr. ticker.
    const built = await buildScanRows(raw, { enrich: source !== 'mock' });
    const rows = built.rows;
    let rejected = [...sourceRejected, ...built.rejected];
    // C-suite-visningen: kun executives eller ægte clusters.
    const transactions = source === 'csuite' && !ticker ? rows.filter((tx) => tx.isExecutiveOfficer || tx.isClusterBuy) : rows;

    let items: Array<{ transaction: InsiderTransaction; result: GatekeeperResult }> = [];
    let scannedAt = new Date().toISOString();
    let stale = false;
    let gatekeeperUsage: GatekeeperUsage | null = null;

    if (transactions.length > 0) {
      const { evaluations, usage } = await evaluateBatchWithGatekeeper(transactions);
      gatekeeperUsage = usage;
      console.log(
        `Gatekeeper (${usage.provider}${usage.model ? `, ${usage.model}` : ''}): ${evaluations.length} rækker, ${usage.calls} kald, ` +
          `${usage.inputTokens} input / ${usage.outputTokens} output / ${usage.cacheCreationInputTokens} cache-skriv / ${usage.cacheReadInputTokens} cache-læs tokens, ` +
          `pris ${usage.costUsd !== undefined ? `$${usage.costUsd.toFixed(4)}` : 'ukendt'}, ${usage.heuristicCount} heuristik, ` +
          `${usage.truncatedChunks} afskåret, ${usage.failedChunks} fejlede chunks`
      );
      // Godkendte og handelbare øverst, derefter højeste geminiPreScore.
      items = [...evaluations].sort((a, b) => {
        const aPassed = a.result.passedHardFilter && a.transaction.isTradableInDK !== false;
        const bPassed = b.result.passedHardFilter && b.transaction.isTradableInDK !== false;
        if (aPassed !== bPassed) return aPassed ? -1 : 1;
        return b.result.geminiPreScore - a.result.geminiPreScore;
      });
      await saveScan(sourceKey, items, rejected);
    } else if (errors.length > 0) {
      // Alle kilder uden rækker og mindst én fejl: vis seneste gemte scan, tydeligt mærket som forældet.
      const cached = await getLatestScan(sourceKey);
      if (cached) {
        items = cached.items;
        rejected = cached.rejected ?? [];
        scannedAt = cached.scannedAt;
        stale = true;
      }
    }

    // 3. Signal-ledger: hver handel, der bestod hard-filteret, logges punkt-i-tid (også dem uden score og
    //    dem, csuite-visningen skjuler). En fejl her vises i svaret, men stopper ikke scannen.
    let ledger: { inserted: number; seen: number; scored: number } | { error: string } | null = null;
    if (source !== 'mock' && !stale && built.passed.length > 0) {
      try {
        const fx = await fetchLiveFxRates().catch(() => null);
        ledger = recordSignals({
          passed: built.passed,
          items,
          scanSource: sourceKey,
          detectedAt: scannedAt,
          gatekeeperModel: gatekeeperUsage?.model,
          fx,
        });
        console.log(`Signal-ledger: ${ledger.inserted} nye, ${ledger.seen} set før, ${ledger.scored} scoret`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('Signal-ledgeren kunne ikke opdateres:', msg);
        ledger = { error: msg };
      }
    }

    return NextResponse.json({
      success: true,
      source: ticker ? `ticker:${ticker}` : source,
      ticker: ticker || null,
      apiKeysConfigured: apiKeysConfigured(),
      scannedAt,
      stale,
      errors,
      count: items.length,
      items,
      gatekeeperUsage,
      ledger,
      autoQueue: await autoQueueFor(items),
      rejectedCount: rejected.length,
      rejected,
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
        error: `Kunne ikke scanne og evaluere insider-transaktioner: ${(error as Error)?.message ?? String(error)}`,
      },
      { status: 500 }
    );
  }
}
