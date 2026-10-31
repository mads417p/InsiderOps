import { NextResponse } from 'next/server';
import {
  getMockTransactions,
  fetchLiveSecForm4s,
  scanTickerSecForm4s,
  fetchExecutiveAndClusterBuys,
  applyTrueClusterDeduplication,
  isValidInsiderName,
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

/**
 * Evaluerer databerigelses-niveauet for en transaktion for at vælge den mest detaljerede
 * version ved sammenlægning af parallelle feeds.
 */
function getEnrichmentScore(tx: InsiderTransaction): number {
  let score = 0;
  if (tx.isClusterBuy) score += 3;
  if (tx.clusterPeers && tx.clusterPeers.length > 0) score += 3;
  if (tx.ownershipNature) score += 2;
  if (tx.isExecutiveOfficer) score += 2;
  if (tx.trackRecord && tx.trackRecord.historicalBuysCount > 0) score += 3;
  if (tx.currentMarketPrice && tx.currentMarketPrice > 0) score += 2;
  if (tx.contextNotes && tx.contextNotes.length > 50) score += 2;
  if (tx.footnotesSummary && tx.footnotesSummary.length > 10) score += 2;
  if (tx.id && tx.id.startsWith('exec-')) score += 1;
  return score;
}

/**
 * Rangerer to transaktioner inden for samme selskab efter signalværdi.
 * Bruges til at udvælge den stærkeste "Lead Row" for en given ticker.
 * Prioritet:
 * 1. Executive Officer (CFO/CEO/COO/Pres/GC) over Director / 10% Owner
 * 2. Direkte ejerskab ('D') over indirekte ('I')
 * 3. Højeste samlede dollarværdi (totalValueUsd)
 * 4. Højeste relative stigning i beholdning (holdingsIncreasePct)
 */
function compareSignalValue(a: InsiderTransaction, b: InsiderTransaction): number {
  // 1. Executive Officer over menige bestyrelsesmedlemmer / passive ejere
  const aExec = a.isExecutiveOfficer ? 1 : 0;
  const bExec = b.isExecutiveOfficer ? 1 : 0;
  if (aExec !== bExec) return bExec - aExec;

  // 2. Direkte ejerskab ('D') over indirekte ('I')
  const aDir = a.ownershipNature === 'D' ? 1 : 0;
  const bDir = b.ownershipNature === 'D' ? 1 : 0;
  if (aDir !== bDir) return bDir - aDir;

  // 3. Største samlede transaktionsbeløb
  const aVal = a.totalValueUsd || 0;
  const bVal = b.totalValueUsd || 0;
  if (aVal !== bVal) return bVal - aVal;

  // 4. Største relative stigning i beholdning
  return (b.holdingsIncreasePct || 0) - (a.holdingsIncreasePct || 0);
}

/**
 * Intelligent Deduplikering, Multi-Market Merge & Cluster Roll-Up.
 * 1. Filtrerer ugyldige insider-navne (f.eks. 'Dir', 'CEO', tomme).
 * 2. Sammenlægger identiske del-handler/rapporteringer af samme person på samme dato.
 * 3. Beregner sande cluster-køb på tværs af hele universet.
 * 4. Konsoliderer til ÉN unik række pr. Ticker:
 *    - Vælger den transaktion i selskabet med højest signalværdi som Lead Row.
 *    - Samler alle øvrige købere i selskabet i leadTx.clusterPeers.
 *    - Sætter leadTx.clusterCount til det samlede antal unikke købere.
 */
function mergeAndDeduplicateTransactions(rawTransactions: InsiderTransaction[]): InsiderTransaction[] {
  // 1. Filtrer eventuelle tomme, ugyldige eller 'Dir' / titel-only transaktioner
  const validTransactions = rawTransactions.filter(
    (tx) => tx && tx.ticker && isValidInsiderName(tx.insiderName)
  );

  const merged: InsiderTransaction[] = [];

  // 2. Sammenlæg duplikerede registreringer af samme person i samme aktie
  for (const tx of validTransactions) {
    const normTicker = tx.ticker.toUpperCase().trim();
    const normName = (tx.insiderName || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 10);
    const filing = tx.filingDate || '';

    // Find om samme person i samme aktie på samme dato allerede er til stede
    const matchIdx = merged.findIndex((existing) => {
      if (existing.ticker.toUpperCase().trim() !== normTicker) return false;
      const exName = (existing.insiderName || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 10);
      if (exName !== normName) return false;
      if (existing.filingDate && filing && existing.filingDate !== filing) return false;

      // Samme antal aktier eller samlet dollar-værdi inden for 5% tolerance
      if (existing.shares === tx.shares) return true;
      if (existing.totalValueUsd && tx.totalValueUsd) {
        const diff = Math.abs(existing.totalValueUsd - tx.totalValueUsd);
        if (diff < 1000 || diff / Math.max(existing.totalValueUsd, tx.totalValueUsd) < 0.05) {
          return true;
        }
      }
      return false;
    });

    if (matchIdx === -1) {
      merged.push({ ...tx });
    } else {
      const existing = merged[matchIdx];
      const existingScore = getEnrichmentScore(existing);
      const newScore = getEnrichmentScore(tx);

      if (newScore > existingScore) {
        merged[matchIdx] = {
          ...existing,
          ...tx,
          contextNotes: tx.contextNotes || existing.contextNotes,
          trackRecord: tx.trackRecord || existing.trackRecord,
          clusterPeers:
            tx.clusterPeers && tx.clusterPeers.length > 0
              ? tx.clusterPeers
              : existing.clusterPeers,
        };
      } else {
        merged[matchIdx] = {
          ...tx,
          ...existing,
          contextNotes: existing.contextNotes || tx.contextNotes,
          trackRecord: existing.trackRecord || tx.trackRecord,
          clusterPeers:
            existing.clusterPeers && existing.clusterPeers.length > 0
              ? existing.clusterPeers
              : tx.clusterPeers,
        };
      }
    }
  }

  // 3. Kør ægte cluster-deduplikering på tværs af de individuelle handler
  applyTrueClusterDeduplication(merged);

  // 4. Konsolider til ÉN række pr. Ticker (Cluster Roll-up)
  const byTicker = new Map<string, InsiderTransaction[]>();
  for (const tx of merged) {
    const key = tx.ticker.toUpperCase().trim();
    if (!byTicker.has(key)) {
      byTicker.set(key, []);
    }
    byTicker.get(key)!.push(tx);
  }

  const consolidated: InsiderTransaction[] = [];

  for (const [, group] of byTicker.entries()) {
    if (group.length === 1) {
      consolidated.push(group[0]);
      continue;
    }

    // Sortér kandidaterne i samme ticker efter signalværdi
    const sorted = [...group].sort(compareSignalValue);
    const leadTx: InsiderTransaction = { ...sorted[0] };

    // Beregn unikke købere i dette selskab
    const uniqueBuyers = new Map<string, InsiderTransaction>();
    for (const tx of sorted) {
      const norm = (tx.insiderName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!uniqueBuyers.has(norm)) {
        uniqueBuyers.set(norm, tx);
      }
    }

    const totalUniqueBuyers = Math.max(uniqueBuyers.size, leadTx.clusterCount || 1);
    if (totalUniqueBuyers >= 2 || sorted.length >= 2) {
      leadTx.isClusterBuy = true;
      leadTx.clusterCount = totalUniqueBuyers;
    }

    // Saml alle øvrige med-købere i leadTx.clusterPeers
    const leadNorm = (leadTx.insiderName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const peers: string[] = [];
    const seenPeerKeys = new Set<string>();

    if (leadTx.clusterPeers && leadTx.clusterPeers.length > 0) {
      for (const p of leadTx.clusterPeers) {
        peers.push(p);
      }
    }

    for (const tx of sorted) {
      const txNorm = (tx.insiderName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (txNorm === leadNorm || seenPeerKeys.has(txNorm)) continue;
      seenPeerKeys.add(txNorm);

      const peerStr = `${tx.insiderName} (${tx.insiderTitle}): $${Math.round(
        tx.totalValueUsd
      ).toLocaleString()} (${tx.shares.toLocaleString()} aktier á $${tx.pricePerShare}) den ${tx.filingDate}`;

      if (!peers.some((p) => p.includes(tx.insiderName))) {
        peers.push(peerStr);
      }
    }

    leadTx.clusterPeers = peers;

    // Lån bedste selskabsnavn eller markedsdata hvis lead mangler det
    const bestName = sorted.find((t) => t.companyName && t.companyName !== t.ticker)?.companyName;
    if (bestName && (!leadTx.companyName || leadTx.companyName === leadTx.ticker)) {
      leadTx.companyName = bestName;
    }

    for (const other of sorted) {
      if (leadTx.currentMarketPrice === undefined && other.currentMarketPrice !== undefined) {
        leadTx.currentMarketPrice = other.currentMarketPrice;
      }
      if (leadTx.marketCapUsd === undefined && other.marketCapUsd !== undefined) {
        leadTx.marketCapUsd = other.marketCapUsd;
      }
      if (leadTx.recentPriceChange30dPct === undefined && other.recentPriceChange30dPct !== undefined) {
        leadTx.recentPriceChange30dPct = other.recentPriceChange30dPct;
      }
      if (leadTx.isTradableInDK === undefined && other.isTradableInDK !== undefined) {
        leadTx.isTradableInDK = other.isTradableInDK;
        leadTx.tradabilityReason = other.tradabilityReason;
      }
    }

    // Opdater kontekst-noter med cluster-overblik
    if (leadTx.isClusterBuy && peers.length > 0 && !leadTx.contextNotes?.includes('BEKRÆFTET CLUSTER-KØB')) {
      const totalClusterUsd = sorted.reduce((sum, item) => sum + (item.totalValueUsd || 0), 0);
      const peerSummary = peers.map((p) => p.split(':')[0]).join(', ');
      const clusterNote = `BEKRÆFTET CLUSTER-KØB (${totalUniqueBuyers} uafhængige insidere, samlet værdi $${Math.round(
        totalClusterUsd
      ).toLocaleString()} USD). Med-købere: ${peerSummary}.`;
      leadTx.contextNotes = leadTx.contextNotes ? `${clusterNote}\n\n${leadTx.contextNotes}` : clusterNote;
    }

    consolidated.push(leadTx);
  }

  return consolidated;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sourceParam = searchParams.get('source');
    const source = sourceParam ? sourceParam.toLowerCase() : 'unified';
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
      } else if (source === 'mock') {
        transactions = getMockTransactions();
      } else {
        // Ny standard: source === 'unified' eller 'all' (Unified Global Omni-Scanner)
        // Kører alle 3 scannere parallelt med Promise.allSettled
        const [csuiteRes, liveRes, nordicRes] = await Promise.allSettled([
          fetchExecutiveAndClusterBuys(25),
          fetchLiveSecForm4s(20),
          fetchNordicInsiderTransactions(),
        ]);

        const csuiteItems = csuiteRes.status === 'fulfilled' ? csuiteRes.value : [];
        const liveItems = liveRes.status === 'fulfilled' ? liveRes.value : [];
        const nordicItems = nordicRes.status === 'fulfilled' ? nordicRes.value : [];

        const allRaw = [...csuiteItems, ...liveItems, ...nordicItems];
        transactions = mergeAndDeduplicateTransactions(allRaw);
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

      // Sorter skarpt efter investerings-relevans:
      // 1. Godkendte (passedHardFilter === true OG isTradableInDK !== false) øverst
      // 2. Højeste geminiPreScore i faldende rækkefølge (Top cases på tværs af USA og Norden øverst)
      sortedEvaluations = [...evaluations].sort((a, b) => {
        const aPassed = a.result.passedHardFilter && a.transaction.isTradableInDK !== false;
        const bPassed = b.result.passedHardFilter && b.transaction.isTradableInDK !== false;
        if (aPassed && !bPassed) return -1;
        if (!aPassed && bPassed) return 1;
        return b.result.geminiPreScore - a.result.geminiPreScore;
      });

      // Gem scanningen i den server-side database under 'unified'
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
