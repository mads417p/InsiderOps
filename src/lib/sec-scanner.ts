import { InsiderTransaction, TransactionCode } from '@/types/insider';
import { enrichTransactionWithMarketData } from '@/lib/market-enricher';

/**
 * Trin 2: Hård filtrering uden API-omkostninger.
 * Afviser handler, der ikke er åbne markedskøb (kode 'P') eller under $50.000 USD.
 */
export function applyHardFilter(tx: InsiderTransaction): { passed: boolean; reason?: string } {
  if (tx.transactionCode !== 'P') {
    const codeName =
      tx.transactionCode === 'M'
        ? "Option Exercise / RSU Vesting ('M')"
        : tx.transactionCode === 'S'
        ? "Almindeligt Salg ('S')"
        : tx.transactionCode === 'F'
        ? "Skatte-salg / Withholding ('F')"
        : tx.transactionCode === 'A'
        ? "Tildeling / Grant ('A')"
        : `Transaktionskode '${tx.transactionCode}'`;

    return {
      passed: false,
      reason: `Afvist: ${codeName}. Kun ægte åbne markedskøb (kode 'P' med egne midler) analyseres.`,
    };
  }

  if (tx.totalValueUsd < 50000) {
    return {
      passed: false,
      reason: `Afvist: Samlet værdi ($${Math.round(tx.totalValueUsd).toLocaleString()}) er under minimumsgrænsen på $50.000 for asymmetrisk signal.`,
    };
  }

  // 3. Tjek DK Handelbarhed & Likviditet (afvis illikvide penny stocks, US OTC og US closed-end fonde / PRIIPs)
  if (tx.isTradableInDK === false) {
    return {
      passed: false,
      reason:
        tx.tradabilityReason ||
        'Afvist: Ikke handelbar i Danmark (PRIIPs/KID blokering, OTC eller penny stock).',
    };
  }

  return { passed: true };
}

/**
 * Bestemmer om en titel tilhører direktionen / C-Suite (Officer).
 * Matcher CFO, CEO, COO, President, General Counsel, VP, Chief osv.,
 * og udelukker rene 'Director' og '10% Owner'.
 */
export function isExecutiveTitle(title?: string): boolean {
  if (!title) return false;
  const t = title.toLowerCase();

  // Hvis det er en ren 10% ejer uden officer rolle
  if (t === '10%' || t === '10% owner' || t === 'ten percent owner') {
    return false;
  }
  // Hvis det kun er en menig bestyrelsespost uden ledelsesfunktion
  if (t === 'dir' || t === 'director' || t === 'board member') {
    return false;
  }

  // Tjek for typiske C-suite og officer titler
  return Boolean(
    t.includes('cfo') ||
      t.includes('chief financial') ||
      t.includes('ceo') ||
      t.includes('chief executive') ||
      t.includes('coo') ||
      t.includes('chief operating') ||
      t.includes('cto') ||
      t.includes('chief technology') ||
      t.includes('cmo') ||
      t.includes('cso') ||
      t.includes('chief scientific') ||
      t.includes('chief') ||
      t.includes('president') ||
      t.includes('pres') ||
      t.includes('general counsel') ||
      t.includes('chief legal') ||
      t.includes('counsel') ||
      t.includes('evp') ||
      t.includes('svp') ||
      t.includes('vice president') ||
      t.includes('vp') ||
      t.includes('treasurer') ||
      t.includes('controller') ||
      t.includes('officer')
  );
}

/**
 * Validerer at et insider-navn er et reelt person- eller fondsnavn
 * og ikke blot en generisk stillingsbetegnelse som 'Dir', 'CEO', 'Vice President' osv.
 */
export function isValidInsiderName(name?: string | null): boolean {
  if (!name) return false;
  const clean = name.replace(/<[^>]+>/g, '').trim();
  if (clean.length < 3) return false;
  if (/^(unknown|n\/a|none|null|undefined)$/i.test(clean)) return false;

  const titleBlacklist =
    /^(dir|director|ceo|cfo|coo|cto|cro|cio|president|pres|vp|evp|svp|vice president|officer|executive officer|board member|ten percent owner|10% owner|owner|insider|ledende medarbejder|medarbejder|styrelseledamot|ledamot|direktør)$/i;
  if (titleBlacklist.test(clean)) return false;

  const parts = clean.split(/[\/,\-&]/).map((p) => p.trim());
  if (parts.length > 1 && parts.every((p) => titleBlacklist.test(p) || p.length <= 2)) {
    return false;
  }

  return true;
}

/**
 * Bestemmer om ejerskabet er direkte ('D') eller indirekte ('I' via fond/trust/holding).
 */
export function detectOwnershipNature(
  rawNature?: string,
  insiderName?: string,
  rawHtml?: string
): 'D' | 'I' {
  if (rawNature === 'D' || rawNature === 'I') return rawNature;

  if (rawHtml) {
    if (rawHtml.toLowerCase().includes('direct shares')) return 'D';
    if (rawHtml.toLowerCase().includes('indirect shares')) return 'I';
  }

  if (insiderName) {
    const n = insiderName.toLowerCase();
    if (
      n.includes(' llc') ||
      n.includes(' lp') ||
      n.includes(' l.p.') ||
      n.includes(' fund') ||
      n.includes(' trust') ||
      n.includes(' capital') ||
      n.includes(' partners') ||
      n.includes(' holdings') ||
      n.includes(' investments') ||
      n.includes(' group') ||
      n.includes(' management') ||
      n.includes(' corp') ||
      n.includes(' inc') ||
      n.includes(' bank')
    ) {
      return 'I';
    }
  }

  return 'D';
}

/**
 * Beregner sande cluster-buys for en liste af transaktioner med person-deduplikering.
 * To indberetninger tæller kun som et cluster-køb, hvis mindst to FORSKELLIGE fysiske personer
 * eller uafhængige parter har købt aktier (eliminerer at 3 partnere rapporterer samme fondskøb som i RENT).
 * Genererer desuden en fuld cluster-oversigt og gemmer med-købere i tx.clusterPeers og tx.contextNotes.
 */
export function applyTrueClusterDeduplication(transactions: InsiderTransaction[]): void {
  const byTicker = new Map<string, InsiderTransaction[]>();
  for (const tx of transactions) {
    if (!byTicker.has(tx.ticker)) {
      byTicker.set(tx.ticker, []);
    }
    byTicker.get(tx.ticker)!.push(tx);
  }

  for (const [, list] of byTicker.entries()) {
    if (list.length <= 1) {
      for (const tx of list) {
        tx.isClusterBuy = false;
        tx.clusterCount = 1;
        tx.clusterPeers = [];
      }
      continue;
    }

    const distinctParticipants: string[] = [];
    const seenSignatures = new Set<string>();

    for (const tx of list) {
      const cleanName = tx.insiderName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const tradeSig = `${tx.filingDate}_${tx.shares}`;

      // Hvis vi allerede har registreret denne præcise handelssignatur (samme dato og samme aktieantal),
      // er det typisk et delt fondskøb rapporteret af flere partnere
      if (seenSignatures.has(tradeSig)) {
        continue;
      }
      seenSignatures.add(tradeSig);

      if (!distinctParticipants.includes(cleanName)) {
        distinctParticipants.push(cleanName);
      }
    }

    const isTrueCluster = distinctParticipants.length >= 2;
    const totalClusterUsd = list.reduce((sum, item) => sum + (item.totalValueUsd || 0), 0);

    for (const tx of list) {
      tx.isClusterBuy = isTrueCluster;
      tx.clusterCount = isTrueCluster ? distinctParticipants.length : 1;

      if (isTrueCluster) {
        const currentClean = tx.insiderName.toLowerCase().replace(/[^a-z0-9]/g, '');
        const peers = list.filter((other) => {
          const otherClean = other.insiderName.toLowerCase().replace(/[^a-z0-9]/g, '');
          return otherClean !== currentClean;
        });

        tx.clusterPeers = peers.map(
          (p) =>
            `${p.insiderName} (${p.insiderTitle}): $${Math.round(p.totalValueUsd).toLocaleString()} (${p.shares.toLocaleString()} aktier á $${p.pricePerShare}) den ${p.filingDate}`
        );

        const peerSummary = peers
          .map(
            (p) =>
              `${p.insiderName} (${p.insiderTitle}): $${Math.round(p.totalValueUsd).toLocaleString()} den ${p.filingDate}`
          )
          .join(', ');

        const clusterNote = `BEKRÆFTET CLUSTER-KØB (${distinctParticipants.length} uafhængige insidere i samme vindue, samlet værdi $${Math.round(totalClusterUsd).toLocaleString()}): Udover denne handel har følgende også købt i åbent marked: ${peerSummary}`;

        if (!tx.contextNotes?.includes('BEKRÆFTET CLUSTER-KØB')) {
          tx.contextNotes = tx.contextNotes ? `${clusterNote}\n\n${tx.contextNotes}` : clusterNote;
        }
      } else {
        tx.clusterPeers = [];
      }
    }
  }
}

/**
 * Returnerer 6 hyper-realistiske mock-transaktioner til test af hele asymmetri-pipelinen.
 */
export function getMockTransactions(): InsiderTransaction[] {
  return [
    {
      id: 'mock-cfo-cluster-buy',
      filingDate: '2026-10-22',
      ticker: 'NVCR',
      companyName: 'NovoCure Therapeutics Corp.',
      insiderName: 'Sarah Jenkins',
      insiderTitle: 'CFO',
      transactionCode: 'P',
      shares: 20000,
      pricePerShare: 24.0,
      totalValueUsd: 480000,
      sharesOwnedFollowing: 67619,
      holdingsIncreasePct: 42.0,
      isClusterBuy: true,
      clusterCount: 2,
      ownershipNature: 'D',
      isExecutiveOfficer: true,
      recentPriceChange30dPct: -28.0,
      currentMarketPrice: 22.8,
      atr14d: 0.95,
      dailyVolatilityPct: 4.17,
      supportLow30d: 21.5,
      resistanceHigh90d: 36.6,
      returnSinceBuyPct: -5.0,
      isTradingBelowInsiderPrice: true,
      exchange: 'NASDAQ',
      isTradableInDK: true,
      tradabilityReason: 'Verificeret: NASDAQ • Likviditet $18.4M/dag • Handelbar på Nordnet / Saxo',
      avgDailyDollarVolume: 18400000,
      secFilingUrl: 'https://www.sec.gov/edgar/data/1029384/000102938426000042/form4.xml',
      trackRecord: {
        historicalBuysCount: 2,
        winRatePct: 100,
        avgReturnPct: 53.6,
        reputation: 'SMART_MONEY_SNIPER',
        reputationLabel: '🎯 Smart Money Sniper (100% Win-Rate, Gns. +53.6%)',
        notablePastTrades: [
          {
            date: '2024-11-12',
            insiderName: 'Sarah Jenkins',
            insiderTitle: 'CFO',
            price: 14.5,
            valueUsd: 290000,
            returnPct: 57.2,
          },
          {
            date: '2024-11-14',
            insiderName: 'Marcus Hall',
            insiderTitle: 'General Counsel',
            price: 15.2,
            valueUsd: 182400,
            returnPct: 50.0,
          },
        ],
      },
      contextNotes:
        'Massivt CFO + General Counsel cluster-køb efter 28% kursfald grundet forsinket FDA-møde. Forøger CFOs beholdning med 42% ($480k).\n\nInsider Alpha: Købskurs $24.00 vs. Aktuel kurs $22.80 (RABAT: Handler 5.0% under insiderens købspris!)\n\nKurs-kontekst: Seneste lukkekurs $22.80 (-28.0% seneste 30d, -37.7% fra 3-mdr top $36.60).\n\nSeneste nyheder & katalysatorer:\n• [21 Oct] NovoCure clarifies timeline for FDA review meeting\n• [18 Oct] Analyst downgrade citing regulatory uncertainty',
    },
    {
      id: 'mock-ceo-cosmetic-buy',
      filingDate: '2026-10-23',
      ticker: 'PLXR',
      companyName: 'Plexus Cloud Systems',
      insiderName: 'Marcus Vance',
      insiderTitle: 'CEO',
      transactionCode: 'P',
      shares: 5000,
      pricePerShare: 13.0,
      totalValueUsd: 65000,
      sharesOwnedFollowing: 1385000,
      holdingsIncreasePct: 0.36,
      isClusterBuy: false,
      clusterCount: 1,
      ownershipNature: 'D',
      isExecutiveOfficer: true,
      recentPriceChange30dPct: -45.0,
      currentMarketPrice: 11.7,
      atr14d: 0.88,
      dailyVolatilityPct: 7.52,
      supportLow30d: 11.2,
      resistanceHigh90d: 31.0,
      returnSinceBuyPct: -10.0,
      isTradingBelowInsiderPrice: true,
      exchange: 'NASDAQ',
      isTradableInDK: true,
      tradabilityReason: 'Verificeret: NASDAQ • Likviditet $4.2M/dag • Handelbar på Nordnet / Saxo',
      avgDailyDollarVolume: 4200000,
      secFilingUrl: 'https://www.sec.gov/edgar/data/1482910/000148291026000115/form4.xml',
      trackRecord: {
        historicalBuysCount: 3,
        winRatePct: 0,
        avgReturnPct: -49.0,
        reputation: 'EARLY_OR_BAGHOLDER',
        reputationLabel: '⚠️ Tidligere køb i minus (0% Win-Rate, Gns. -49.0%) - Bagholder-risiko',
        notablePastTrades: [
          {
            date: '2024-08-15',
            insiderName: 'Marcus Vance',
            insiderTitle: 'CEO',
            price: 28.0,
            valueUsd: 140000,
            returnPct: -58.2,
          },
          {
            date: '2024-11-20',
            insiderName: 'Marcus Vance',
            insiderTitle: 'CEO',
            price: 24.0,
            valueUsd: 120000,
            returnPct: -51.3,
          },
          {
            date: '2025-03-10',
            insiderName: 'Marcus Vance',
            insiderTitle: 'CEO',
            price: 19.0,
            valueUsd: 95000,
            returnPct: -38.4,
          },
        ],
      },
      contextNotes:
        'CEO "Cosmetic / PR Buy" i presset selskab. Køb for $65k er mikroskopisk mod en eksisterende beholdning på $18 mio. (kun +0.36% forøgelse).\n\nInsider Alpha: Købskurs $13.00 vs. Aktuel kurs $11.70 (RABAT: Handler 10.0% under insiderens købspris!)\n\nKurs-kontekst: Seneste lukkekurs $11.70 (-45.0% seneste 30d, -62.3% fra 3-mdr top $31.00).\n\nSeneste nyheder & katalysatorer:\n• [20 Oct] Plexus Cloud lowers ARR guidance for Q4\n• [15 Oct] Major enterprise customer churn reported',
    },
    {
      id: 'mock-chair-cfo-earnings-buy',
      filingDate: '2026-10-21',
      ticker: 'MTLR',
      companyName: 'Vanguard Industrial Dynamics',
      insiderName: 'David K. Holm',
      insiderTitle: 'Chairman of the Board',
      transactionCode: 'P',
      shares: 10000,
      pricePerShare: 31.0,
      totalValueUsd: 310000,
      sharesOwnedFollowing: 45714,
      holdingsIncreasePct: 28.0,
      isClusterBuy: true,
      clusterCount: 2,
      ownershipNature: 'D',
      isExecutiveOfficer: true,
      recentPriceChange30dPct: 3.5,
      currentMarketPrice: 34.1,
      atr14d: 0.9,
      dailyVolatilityPct: 2.64,
      supportLow30d: 31.2,
      resistanceHigh90d: 35.8,
      returnSinceBuyPct: 10.0,
      isTradingBelowInsiderPrice: false,
      exchange: 'NYSE',
      isTradableInDK: true,
      tradabilityReason: 'Verificeret: NYSE • Likviditet $12.1M/dag • Handelbar på Nordnet / Saxo',
      avgDailyDollarVolume: 12100000,
      secFilingUrl: 'https://www.sec.gov/edgar/data/1129381/000112938126000089/form4.xml',
      trackRecord: {
        historicalBuysCount: 0,
        winRatePct: 0,
        avgReturnPct: 0,
        reputation: 'FIRST_TIME_OR_RARE',
        reputationLabel: '🆕 Sjældent signal: Første åbne markedskøb fra ledelsen i >3 år',
        notablePastTrades: [],
      },
      contextNotes:
        'Stille Bestyrelsesformand + CFO køb ($310.000, +28% beholdning) i overset industriaktie to uger før kvartalsregnskab.\n\nInsider Alpha: Købskurs $31.00 vs. Aktuel kurs $34.10 (Insider afkast siden køb: +10.0%)\n\nKurs-kontekst: Seneste lukkekurs $34.10 (+3.5% seneste 30d, +7.7% fra 3-mdr top $31.65).\n\nSeneste nyheder & katalysatorer:\n• [19 Oct] Vanguard wins $85M infrastructure supply contract\n• [10 Oct] Q3 earnings scheduled for release November 6',
    },
    {
      id: 'mock-option-exercise-m',
      filingDate: '2026-10-24',
      ticker: 'MEDX',
      companyName: 'Medix Therapeutics Corp.',
      insiderName: 'Elena Rostova',
      insiderTitle: 'Chief Scientific Officer',
      transactionCode: 'M',
      shares: 40000,
      pricePerShare: 30.0,
      totalValueUsd: 1200000,
      sharesOwnedFollowing: 120000,
      holdingsIncreasePct: 50.0,
      isClusterBuy: false,
      ownershipNature: 'D',
      isExecutiveOfficer: true,
      secFilingUrl: 'https://www.sec.gov/edgar/data/1589302/000158930226000012/form4.xml',
      contextNotes:
        'Option exercise (M) på $1.200.000. Tildelt incitamentsprogram, ikke køb med egne opsparede midler på det åbne marked.',
    },
    {
      id: 'mock-director-small-buy',
      filingDate: '2026-10-23',
      ticker: 'SOLR',
      companyName: 'Solaris Energy Group',
      insiderName: 'Arthur Pendelton',
      insiderTitle: 'Director',
      transactionCode: 'P',
      shares: 1000,
      pricePerShare: 18.5,
      totalValueUsd: 18500,
      sharesOwnedFollowing: 15000,
      holdingsIncreasePct: 7.1,
      isClusterBuy: false,
      ownershipNature: 'D',
      isExecutiveOfficer: false,
      currentMarketPrice: 17.9,
      returnSinceBuyPct: -3.24,
      isTradingBelowInsiderPrice: true,
      secFilingUrl: 'https://www.sec.gov/edgar/data/1392019/000139201926000005/form4.xml',
      contextNotes:
        'Småkøb (P) på $18.500 fra bestyrelsesmedlem. Under minimumsgrænsen på $50.000, typisk symbolsk eller støj.',
    },
    {
      id: 'mock-insider-sale-s',
      filingDate: '2026-10-24',
      ticker: 'APEX',
      companyName: 'Apex Data Networks',
      insiderName: 'Jonathan Reiss',
      insiderTitle: 'CTO',
      transactionCode: 'S',
      shares: 15000,
      pricePerShare: 60.0,
      totalValueUsd: 900000,
      sharesOwnedFollowing: 85000,
      holdingsIncreasePct: -15.0,
      isClusterBuy: false,
      ownershipNature: 'D',
      isExecutiveOfficer: true,
      secFilingUrl: 'https://www.sec.gov/edgar/data/1209384/000120938426000201/form4.xml',
      contextNotes:
        'Insider Salg (S) på $900.000 under 10b5-1 plan. Bliver filtreret fra, da vi udelukkende screener for købsasymmetri.',
    },
    {
      id: 'mock-10b51-plan-buy',
      filingDate: '2026-10-24',
      ticker: 'PLAN',
      companyName: 'Planar Automated Systems Inc.',
      insiderName: 'Robert Sterling',
      insiderTitle: 'Chief Operating Officer',
      transactionCode: 'P',
      shares: 10000,
      pricePerShare: 25.0,
      totalValueUsd: 250000,
      sharesOwnedFollowing: 55000,
      holdingsIncreasePct: 22.2,
      isClusterBuy: false,
      clusterCount: 1,
      ownershipNature: 'D',
      isExecutiveOfficer: true,
      is10b51Plan: true,
      footnotesSummary:
        '[F1] The purchases reported in this Form 4 were effected pursuant to a Rule 10b5-1 trading plan adopted by the Reporting Person on March 15, 2026.',
      recentPriceChange30dPct: -12.0,
      currentMarketPrice: 24.5,
      atr14d: 0.85,
      dailyVolatilityPct: 3.47,
      supportLow30d: 23.8,
      resistanceHigh90d: 29.5,
      returnSinceBuyPct: -2.0,
      isTradingBelowInsiderPrice: true,
      exchange: 'NASDAQ',
      isTradableInDK: true,
      tradabilityReason: 'Verificeret: NASDAQ • Likviditet $9.2M/dag • Handelbar på Nordnet / Saxo',
      avgDailyDollarVolume: 9200000,
      secFilingUrl: 'https://www.sec.gov/edgar/data/1999999/000199999926000001/form4.xml',
      trackRecord: {
        historicalBuysCount: 2,
        winRatePct: 50,
        avgReturnPct: 4.5,
        reputation: 'CREDIBLE_BUYER',
        reputationLabel: '📈 Kredibel køber (50% Win-Rate, Gns. +4.5%)',
        notablePastTrades: [
          {
            date: '2025-06-15',
            insiderName: 'Robert Sterling',
            insiderTitle: 'COO',
            price: 21.0,
            valueUsd: 105000,
            returnPct: 16.7,
          },
          {
            date: '2025-12-15',
            insiderName: 'Robert Sterling',
            insiderTitle: 'COO',
            price: 26.5,
            valueUsd: 132500,
            returnPct: -7.5,
          },
        ],
      },
      contextNotes:
        'SEC Form 4 Fodnoter (Det med småt):\n[F1] The purchases reported in this Form 4 were effected pursuant to a Rule 10b5-1 trading plan adopted by the Reporting Person on March 15, 2026.\n\nAutomatisk eksekveret køb under Rule 10b5-1 handelsplan indgået for 7 måneder siden. 0% aktuel informationsasymmetri.',
    },
  ];
}

interface ParsedSubTransaction {
  code: TransactionCode;
  isAcquisition: boolean;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  sharesOwnedFollowing: number;
}

/**
 * Parser og aggregerer transaktionsblokke (håndterer split-lots og summerer del-handler for samme insider).
 * Verificerer strengt at kode P kun accepteres hvis transaktionen er en reel erhvervelse (Acquired 'A').
 */
function parseAndAggregateTransactions(xml: string): {
  code: TransactionCode;
  shares: number;
  pricePerShare: number;
  totalValueUsd: number;
  sharesOwnedFollowing: number;
  holdingsIncreasePct: number;
} | null {
  const txMatches = [...xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi)];

  const parsedSubTxs: ParsedSubTransaction[] = [];

  for (const match of txMatches) {
    const block = match[1];
    const codeMatch = block.match(/<transactionCoding>[\s\S]*?<transactionCode>\s*([A-Za-z])\s*<\/transactionCode>/i);
    const adMatch = block.match(/<transactionAcquiredDisposedCode>\s*<value>\s*([A-Za-z])\s*<\/value>/i);
    const rawCode = (codeMatch ? codeMatch[1].toUpperCase() : '') as TransactionCode;
    const adCode = adMatch ? adMatch[1].toUpperCase() : '';

    if (!rawCode) continue;

    const sharesStr = block.match(/<transactionShares>\s*<value>\s*(.*?)\s*<\/value>/i)?.[1]?.trim();
    const priceStr = block.match(/<transactionPricePerShare>\s*<value>\s*(.*?)\s*<\/value>/i)?.[1]?.trim();
    const ownedFollowingStr = block.match(
      /<sharesOwnedFollowingTransaction>\s*<value>\s*(.*?)\s*<\/value>/i
    )?.[1]?.trim();

    const shares = parseFloat(sharesStr || '0');
    const price = parseFloat(priceStr || '0');
    const ownedFollowing = parseFloat(ownedFollowingStr || '0');
    const totalVal = shares * price;

    // Et åbent markedskøb SKAL være eksplicit kode 'P' OG have acquiredDisposedCode 'A' (Acquired)
    const isTruePurchase = rawCode === 'P' && adCode === 'A';
    const validCode: TransactionCode = isTruePurchase
      ? 'P'
      : ['S', 'A', 'M', 'F', 'G', 'D'].includes(rawCode)
      ? rawCode
      : adCode === 'D'
      ? 'S'
      : 'A';

    parsedSubTxs.push({
      code: validCode,
      isAcquisition: adCode === 'A',
      shares,
      pricePerShare: price,
      totalValue: totalVal,
      sharesOwnedFollowing: ownedFollowing,
    });
  }

  // Fallback hvis ingen standard nonDerivativeTransaction blokke blev fundet
  if (parsedSubTxs.length === 0) {
    const codeMatch = xml.match(/<transactionCoding>[\s\S]*?<transactionCode>\s*([A-Za-z])\s*<\/transactionCode>/i);
    const adMatch = xml.match(/<transactionAcquiredDisposedCode>\s*<value>\s*([A-Za-z])\s*<\/value>/i);
    const rawCode = (codeMatch ? codeMatch[1].toUpperCase() : '') as TransactionCode;
    const adCode = adMatch ? adMatch[1].toUpperCase() : '';
    if (!rawCode) return null;

    const isTruePurchase = rawCode === 'P' && adCode === 'A';
    const validCode: TransactionCode = isTruePurchase
      ? 'P'
      : ['S', 'A', 'M', 'F', 'G', 'D'].includes(rawCode)
      ? rawCode
      : adCode === 'D'
      ? 'S'
      : 'A';

    const shares = parseFloat(xml.match(/<transactionShares>\s*<value>\s*(.*?)\s*<\/value>/i)?.[1] || '0');
    const price = parseFloat(xml.match(/<transactionPricePerShare>\s*<value>\s*(.*?)\s*<\/value>/i)?.[1] || '0');
    const owned = parseFloat(
      xml.match(/<sharesOwnedFollowingTransaction>\s*<value>\s*(.*?)\s*<\/value>/i)?.[1] || '0'
    );
    const prior = owned - shares;
    const pct = prior > 0 ? parseFloat(((shares / prior) * 100).toFixed(2)) : 0.0;
    return {
      code: validCode,
      shares,
      pricePerShare: price,
      totalValueUsd: shares * price,
      sharesOwnedFollowing: owned,
      holdingsIncreasePct: pct,
    };
  }

  // Prioriter Open Market Purchases ('P' med 'A') og aggreger alle del-linjer
  const pTransactions = parsedSubTxs.filter((t) => t.code === 'P');

  if (pTransactions.length > 0) {
    const totalShares = pTransactions.reduce((acc, t) => acc + t.shares, 0);
    const totalValueUsd = pTransactions.reduce((acc, t) => acc + t.totalValue, 0);
    const avgPrice = totalShares > 0 ? Number((totalValueUsd / totalShares).toFixed(4)) : pTransactions[0].pricePerShare;
    const sharesOwnedFollowing = Math.max(...pTransactions.map((t) => t.sharesOwnedFollowing));
    const priorShares = sharesOwnedFollowing - totalShares;
    const holdingsIncreasePct =
      priorShares > 0 ? parseFloat(((totalShares / priorShares) * 100).toFixed(2)) : 100.0;

    return {
      code: 'P',
      shares: totalShares,
      pricePerShare: avgPrice,
      totalValueUsd,
      sharesOwnedFollowing,
      holdingsIncreasePct,
    };
  }

  // Hvis ingen 'P', tag den første eller største transaktion (f.eks. F, S, M eller A)
  const primaryTx = parsedSubTxs[0];
  const prior = primaryTx.sharesOwnedFollowing - (primaryTx.isAcquisition ? primaryTx.shares : -primaryTx.shares);
  const pct = prior > 0 ? parseFloat(((primaryTx.shares / prior) * 100).toFixed(2)) : 0.0;

  return {
    code: primaryTx.code,
    shares: primaryTx.shares,
    pricePerShare: primaryTx.pricePerShare,
    totalValueUsd: primaryTx.totalValue,
    sharesOwnedFollowing: primaryTx.sharesOwnedFollowing,
    holdingsIncreasePct: pct,
  };
}

/**
 * Henter og parser en individuel Form 4 XML filing givet dens Atom-indhold.
 */
async function parseForm4Entry(
  entryContent: string,
  userAgent: string,
  defaultTicker?: string,
  defaultCompanyName?: string
): Promise<InsiderTransaction | null> {
  const linkMatch = entryContent.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (!linkMatch) return null;

  let indexUrl = linkMatch[1];
  if (!indexUrl.startsWith('http')) {
    indexUrl = 'https://www.sec.gov' + indexUrl;
  }

  try {
    const indexResponse = await fetch(indexUrl, {
      headers: { 'User-Agent': userAgent },
    });

    if (!indexResponse.ok) return null;

    const indexHtml = await indexResponse.text();
    const xmlMatch = indexHtml.match(/href=["'](\/Archives\/edgar\/data\/[^"']+\.xml)["']/i);
    if (!xmlMatch) return null;

    // Strip stylesheet prefix (f.eks. /xslF345X06/) for at få den rå XML-fil
    const rawXmlPath = xmlMatch[1].replace(/\/xsl[^\/]+\//i, '/');
    const rawXmlUrl = 'https://www.sec.gov' + rawXmlPath;

    const xmlResponse = await fetch(rawXmlUrl, {
      headers: { 'User-Agent': userAgent },
    });

    if (!xmlResponse.ok) return null;

    const xml = await xmlResponse.text();

    // Udtræk selskabs- og ejer-info
    const tickerFromXml = xml.match(/<issuerTradingSymbol>\s*(.*?)\s*<\/issuerTradingSymbol>/i)?.[1]?.trim();
    const ticker = tickerFromXml || defaultTicker;
    const companyFromXml = xml.match(/<issuerName>\s*(.*?)\s*<\/issuerName>/i)?.[1]?.trim();
    const companyName = companyFromXml || defaultCompanyName || ticker;
    const insiderName = xml.match(/<rptOwnerName>\s*(.*?)\s*<\/rptOwnerName>/i)?.[1]?.trim();

    if (!ticker || !insiderName || !isValidInsiderName(insiderName)) return null;

    // Udtræk og aggreger del-linjer (split-lots)
    const aggregated = parseAndAggregateTransactions(xml);
    if (!aggregated) return null;

    // Udtræk titel / rolle
    let insiderTitle = xml.match(/<officerTitle>\s*(.*?)\s*<\/officerTitle>/i)?.[1]?.trim();
    if (!insiderTitle) {
      if (/<isDirector>\s*1\s*<\/isDirector>/i.test(xml)) {
        insiderTitle = 'Director';
      } else if (/<isTenPercentOwner>\s*1\s*<\/isTenPercentOwner>/i.test(xml)) {
        insiderTitle = '10% Owner';
      } else if (/<isOfficer>\s*1\s*<\/isOfficer>/i.test(xml)) {
        insiderTitle = 'Officer';
      } else {
        insiderTitle = 'Insider';
      }
    }

    const filingDate =
      xml.match(/<periodOfReport>\s*(.*?)\s*<\/periodOfReport>/i)?.[1]?.trim() ||
      new Date().toISOString().split('T')[0];

    const ownershipVal = xml
      .match(/<directOrIndirectOwnership>\s*<value>\s*([DI])\s*<\/value>/i)?.[1]
      ?.toUpperCase();
    const ownershipNature: 'D' | 'I' = ownershipVal === 'I' ? 'I' : 'D';
    const isExecutiveOfficer = isExecutiveTitle(insiderTitle);

    // Tjek om handlen er eksekveret under en Rule 10b5-1 automatisk handelsplan
    const aff10b5One = /<aff10b5One>\s*(1|true)\s*<\/aff10b5One>/i.test(xml);

    // Udtræk alle fodnoter fra <footnotes> sektionen
    const footnoteMatches = [...xml.matchAll(/<footnote\s+id=["']?([^"'>]+)["']?>([\s\S]*?)<\/footnote>/gi)];
    const footnotesSummary = footnoteMatches
      .map((m) => `[${m[1]}] ${m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`)
      .join('\n');

    const has10b51InFootnotes = /10b5-?1|rule\s*10b5|pre-arranged|automatic\s*(?:purchase|trading)/i.test(
      `${footnotesSummary} ${xml}`
    );
    const is10b51Plan = aff10b5One || has10b51InFootnotes;

    const transaction: InsiderTransaction = {
      id: `sec-${ticker}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      filingDate,
      ticker,
      companyName: companyName || ticker,
      insiderName,
      insiderTitle,
      transactionCode: aggregated.code,
      shares: aggregated.shares,
      pricePerShare: aggregated.pricePerShare,
      totalValueUsd: aggregated.totalValueUsd,
      sharesOwnedFollowing: aggregated.sharesOwnedFollowing,
      holdingsIncreasePct: aggregated.holdingsIncreasePct,
      isClusterBuy: false,
      clusterCount: 1,
      ownershipNature,
      isExecutiveOfficer,
      is10b51Plan,
      footnotesSummary: footnotesSummary || undefined,
      secFilingUrl: rawXmlUrl,
      contextNotes: footnotesSummary
        ? `SEC Form 4 Fodnoter (Det med småt):\n${footnotesSummary}`
        : undefined,
    };

    return transaction;
  } catch (err) {
    console.warn(`Fejl ved parsing af ${indexUrl}:`, err);
    return null;
  }
}

/**
 * In-memory cache for SEC company tickers -> CIK opslag.
 */
let tickerCikCache: Map<string, { cik: string; title: string }> | null = null;

/**
 * Slår en tickers 10-cifrede CIK-nummer op via SEC company_tickers.json.
 */
export async function getCikForTicker(
  ticker: string,
  userAgent: string
): Promise<{ cik: string; title: string } | null> {
  const cleanTicker = ticker.trim().toUpperCase();

  if (tickerCikCache && tickerCikCache.has(cleanTicker)) {
    return tickerCikCache.get(cleanTicker)!;
  }

  try {
    const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/json',
      },
    });

    if (!res.ok) return null;

    const data = await res.json();
    const map = new Map<string, { cik: string; title: string }>();

    for (const item of Object.values(data) as Array<{ cik_str: number; ticker: string; title: string }>) {
      if (item && item.ticker) {
        map.set(item.ticker.toUpperCase(), {
          cik: String(item.cik_str),
          title: item.title,
        });
      }
    }

    tickerCikCache = map;
    return tickerCikCache.get(cleanTicker) || null;
  } catch (err) {
    console.warn('Kunne ikke hente SEC company_tickers.json:', err);
    return null;
  }
}

/**
 * Dynamisk parser for OpenInsider tinytable tabeller.
 * Udleder automatisk kolonne-indekser fra <th> overskrifterne,
 * så parsing er 100% robust uanset om OpenInsider viser 16 eller 17 kolonner.
 */
function parseOpenInsiderTable(html: string, idPrefix: string): InsiderTransaction[] {
  const tableMatch = html.match(/<table[^>]*class=["']tinytable["'][\s\S]*?<\/table>/i);
  if (!tableMatch) return [];

  const trMatches = [...tableMatch[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)];
  if (trMatches.length < 2) return [];

  // Parse headers dynamisk
  const thHeaders = [...trMatches[0][0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(
    (m) => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').toLowerCase().trim()
  );

  const colFiling = thHeaders.findIndex((h) => h.includes('filing'));
  const colTicker = thHeaders.findIndex((h) => h.includes('ticker'));
  const colCompany = thHeaders.findIndex((h) => h.includes('company'));
  const colInsider = thHeaders.findIndex((h) => h.includes('insider'));
  const colTitle = thHeaders.findIndex((h) => h.includes('title'));
  const colPrice = thHeaders.findIndex((h) => h.includes('price'));
  const colQty = thHeaders.findIndex((h) => h.includes('qty'));
  const colOwned = thHeaders.findIndex((h) => h.includes('owned'));
  const colDeltaOwn = thHeaders.findIndex(
    (h) => h.includes('own') && (h.includes('δ') || h.includes('delta') || h.includes('&delta;') || h.includes('Δ'))
  );
  const colValue = thHeaders.findIndex((h) => h.includes('value'));

  if (colTicker === -1 || colInsider === -1 || colPrice === -1 || colQty === -1) {
    return [];
  }

  const transactions: InsiderTransaction[] = [];

  for (let i = 1; i < trMatches.length; i++) {
    const rowHtml = trMatches[i][0];
    const tdMatches = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    const maxRequired = Math.max(colTicker, colInsider, colPrice, colQty, colValue !== -1 ? colValue : 0);
    if (tdMatches.length <= maxRequired) continue;

    const filingDate =
      colFiling !== -1 && tdMatches[colFiling]
        ? tdMatches[colFiling].replace(/<[^>]+>/g, '').trim().split(' ')[0]
        : new Date().toISOString().split('T')[0];

    const secLinkMatch = rowHtml.match(
      /href="(https?:\/\/(?:www\.)?sec\.gov\/Archives\/edgar\/data\/[^\s"'>]+)"/i
    );
    const secFilingUrl = secLinkMatch
      ? secLinkMatch[1].replace(/^http:/, 'https:')
      : 'https://www.sec.gov';

    const tickerMatch =
      tdMatches[colTicker]?.match(/href="\/([A-Za-z0-9.\-]+)"/i) ||
      tdMatches[colTicker]?.match(/>([A-Z0-9.\-]+)<\/a>/i);
    const ticker = tickerMatch ? tickerMatch[1].toUpperCase() : 'UNKNOWN';
    if (!ticker || ticker === 'UNKNOWN') continue;

    const companyName =
      colCompany !== -1 && tdMatches[colCompany]
        ? tdMatches[colCompany].replace(/<[^>]+>/g, '').trim()
        : ticker;

    const insiderName = tdMatches[colInsider]?.replace(/<[^>]+>/g, '').trim();
    if (!isValidInsiderName(insiderName)) continue;

    const insiderTitle =
      colTitle !== -1 && tdMatches[colTitle]
        ? tdMatches[colTitle].replace(/<[^>]+>/g, '').trim() || 'Insider'
        : 'Insider';

    const priceStr = tdMatches[colPrice]?.replace(/<[^>]+>/g, '').replace(/[$,]/g, '').trim();
    const pricePerShare = parseFloat(priceStr) || 0;

    const qtyStr = tdMatches[colQty]?.replace(/<[^>]+>/g, '').replace(/[+,\s]/g, '').trim();
    const shares = parseInt(qtyStr, 10) || 0;

    const ownedStr =
      colOwned !== -1 && tdMatches[colOwned]
        ? tdMatches[colOwned].replace(/<[^>]+>/g, '').replace(/[,]/g, '').trim()
        : '0';
    const sharesOwnedFollowing = parseInt(ownedStr, 10) || 0;

    const deltaOwnStr =
      colDeltaOwn !== -1 && tdMatches[colDeltaOwn]
        ? tdMatches[colDeltaOwn].replace(/<[^>]+>/g, '').trim()
        : '';
    let holdingsIncreasePct = 0;
    if (deltaOwnStr.toLowerCase().includes('new')) {
      holdingsIncreasePct = 100.0;
    } else {
      const clean = deltaOwnStr.replace(/[%,\s]/g, '').replace(/^\+/, '');
      holdingsIncreasePct = parseFloat(clean) || 0;
    }

    const valStr =
      colValue !== -1 && tdMatches[colValue]
        ? tdMatches[colValue].replace(/<[^>]+>/g, '').replace(/[+$,\s]/g, '').trim()
        : '';
    const totalValueUsd = parseFloat(valStr) || shares * pricePerShare;

    const isDirect = rowHtml.includes('direct shares');
    const isIndirect = rowHtml.includes('indirect shares');
    const ownershipNature: 'D' | 'I' = isIndirect
      ? 'I'
      : isDirect
      ? 'D'
      : detectOwnershipNature(undefined, insiderName, rowHtml);
    const isExecutiveOfficer = isExecutiveTitle(insiderTitle);
    const is10b51Plan = /10b5-?1/i.test(rowHtml);

    transactions.push({
      id: `${idPrefix}-${ticker}-${filingDate}-${shares}-${Math.round(totalValueUsd)}`,
      filingDate,
      ticker,
      companyName,
      insiderName,
      insiderTitle,
      transactionCode: 'P',
      shares,
      pricePerShare,
      totalValueUsd,
      sharesOwnedFollowing,
      holdingsIncreasePct,
      isClusterBuy: false,
      clusterCount: 1,
      ownershipNature,
      isExecutiveOfficer,
      is10b51Plan,
      secFilingUrl,
    });
  }

  return transactions;
}

/**
 * Dedikeret "Pure Kode P" Open-Market Purchase Hunter.
 * Henter bekræftede amerikanske åbne markedskøb (Kode P) > $50.000 fra de seneste handelsdage.
 * Detekterer cluster-buys og beriger transaktionerne med live markedskurser og alpha.
 */
export async function fetchHighConvictionOpenMarketBuys(limit: number = 20): Promise<InsiderTransaction[]> {
  const url = `http://openinsider.com/screener?s=&o=&pl=&ph=&ll=&lh=&fd=14&fdr=&td=0&tdr=&feession=&feession=&xp=1&vl=50&vh=&ocl=&och=&sic1=-1&sicl=100&sich=9999&grp=0&nfl=&nfh=&nil=&nih=&nol=&noh=&v2l=&v2h=&oc2l=&oc2h=&sortcol=0&cnt=${encodeURIComponent(
    limit
  )}&page=1`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`OpenInsider returnerede status ${res.status}`);
      return [];
    }

    const html = await res.text();
    const transactions = parseOpenInsiderTable(html, 'live-buy');

    // Detekter sande cluster buys med person-deduplikering
    applyTrueClusterDeduplication(transactions);

    // Berig med Yahoo Finance kurs- og nyhedsdata
    await Promise.allSettled(
      transactions.slice(0, 15).map((tx) => enrichTransactionWithMarketData(tx))
    );

    return transactions;
  } catch (err) {
    console.warn('Kunne ikke hente Open Market Purchases fra hunter kilde:', err);
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Henter seneste Form 4 filings fra det rå SEC EDGAR Atom/XML feed.
 */
async function fetchRawSecEdgarAtomFeed(limit: number = 8): Promise<InsiderTransaction[]> {
  const userAgent = process.env.SEC_USER_AGENT || 'InsiderOps/1.0 (mads.rosengaard2003@gmail.com)';
  const feedUrl =
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=only&start=0&count=40&output=atom';

  try {
    const feedResponse = await fetch(feedUrl, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/atom+xml, application/xml, text/xml',
      },
    });

    if (!feedResponse.ok) {
      return [];
    }

    const feedXml = await feedResponse.text();
    const entryMatches = [...feedXml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];

    if (!entryMatches || entryMatches.length === 0) {
      return [];
    }

    const entriesToProcess = entryMatches.slice(0, Math.min(entryMatches.length, limit * 2, 16));
    const transactions: InsiderTransaction[] = [];
    const BATCH_SIZE = 8;

    for (let i = 0; i < entriesToProcess.length; i += BATCH_SIZE) {
      const chunk = entriesToProcess.slice(i, i + BATCH_SIZE);
      const chunkResults = await Promise.all(chunk.map((m) => parseForm4Entry(m[1], userAgent)));

      for (const tx of chunkResults) {
        if (tx) transactions.push(tx);
      }

      if (transactions.length >= limit) break;
    }

    return transactions;
  } catch (err) {
    console.warn('Fejl ved hentning af råt SEC Atom feed:', err);
    return [];
  }
}

/**
 * Rå OpenInsider scraper for C-Suite officers (isofficer=1).
 */
async function fetchRawExecutiveOfficerBuys(limit: number = 25): Promise<InsiderTransaction[]> {
  const url = `http://openinsider.com/screener?s=&o=&pl=&ph=&ll=&lh=&fd=30&fdr=&td=0&tdr=&fdlyl=&fdlyh=&daysago=&xp=1&isofficer=1&vl=50&vh=&sortcol=0&cnt=${encodeURIComponent(
    limit
  )}&page=1`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 7000);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn(`OpenInsider Officer Hunter returnerede status ${res.status}`);
      return [];
    }

    const html = await res.text();
    const transactions = parseOpenInsiderTable(html, 'exec-buy');
    for (const tx of transactions) {
      tx.isExecutiveOfficer = true;
    }

    return transactions;
  } catch (err) {
    console.warn('Kunne ikke hente rå C-Suite Officer Purchases:', err);
    return [];
  }
}

/**
 * Dedikeret "C-Suite Executive Hunter" (Kun CEO, CFO, COO, GC, Pres, EVP > $50.000).
 * Krydstjekker automatisk med det bredere åbne marked for at forbinde C-Suite køb
 * med eventuelle med-købere (Directors, bestyrelse, andre partnere) i samme ticker.
 */
export async function fetchExecutiveAndClusterBuys(limit: number = 25): Promise<InsiderTransaction[]> {
  try {
    const [execResult, generalResult] = await Promise.allSettled([
      fetchRawExecutiveOfficerBuys(limit),
      fetchHighConvictionOpenMarketBuys(25),
    ]);

    const execBuys = execResult.status === 'fulfilled' ? execResult.value : [];
    const generalBuys = generalResult.status === 'fulfilled' ? generalResult.value : [];

    const pool: InsiderTransaction[] = [];
    const seen = new Set<string>();

    for (const tx of [...execBuys, ...generalBuys]) {
      const key = `${tx.ticker}_${tx.filingDate}_${tx.shares}_${tx.insiderName.slice(0, 10)}`;
      if (!seen.has(key)) {
        seen.add(key);
        pool.push(tx);
      }
    }

    // Beregn sande cluster-køb på tværs af hele puljen med person-deduplikering og med-købere
    applyTrueClusterDeduplication(pool);

    // Filtrer transaktioner hvor personen er en Executive Officer (eller del af et verificeret cluster buy)
    const result = pool
      .filter((tx) => isValidInsiderName(tx.insiderName))
      .filter((tx) => tx.isExecutiveOfficer || tx.isClusterBuy)
      .slice(0, Math.max(limit, 25));

    // Berig alle udvalgte kandidater med Yahoo Finance markedskurs, likviditet og DK handelbarhed
    await Promise.allSettled(
      result.map((tx) => enrichTransactionWithMarketData(tx))
    );

    return result;
  } catch (err) {
    console.warn('Kunne ikke hente C-Suite Officer Purchases:', err);
    return [];
  }
}

/**
 * Kombinerer C-Suite Executive Hunter, den generelle Open-Market Hunter og det rå SEC EDGAR Atom feed.
 * Giver brugeren et rigt feed af bekræftede amerikanske åbne markedskøb over $50k med sand cluster-deduplikering.
 */
export async function fetchLiveSecForm4s(limit: number = 20): Promise<InsiderTransaction[]> {
  try {
    const [execResult, hunterResult, rawSecResult] = await Promise.allSettled([
      fetchExecutiveAndClusterBuys(15),
      fetchHighConvictionOpenMarketBuys(15),
      fetchRawSecEdgarAtomFeed(8),
    ]);

    const execBuys = execResult.status === 'fulfilled' ? execResult.value : [];
    const hunterBuys = hunterResult.status === 'fulfilled' ? hunterResult.value : [];
    const rawFilings = rawSecResult.status === 'fulfilled' ? rawSecResult.value : [];

    const combined: InsiderTransaction[] = [];
    const seen = new Set<string>();

    for (const tx of [...execBuys, ...hunterBuys, ...rawFilings]) {
      const key = `${tx.ticker}_${tx.filingDate}_${tx.shares}_${tx.insiderName.slice(0, 10)}`;
      if (!seen.has(key)) {
        seen.add(key);
        combined.push(tx);
      }
    }

    const valid = combined.filter((tx) => isValidInsiderName(tx.insiderName));
    if (valid.length === 0) {
      return [];
    }

    // Genberegn sande cluster buys på tværs af de kombinerede feeds
    applyTrueClusterDeduplication(valid);

    const finalSelection = valid.slice(0, Math.max(limit, 20));
    await Promise.allSettled(
      finalSelection
        .filter((tx) => tx.isTradableInDK === undefined)
        .map((tx) => enrichTransactionWithMarketData(tx))
    );

    return finalSelection;
  } catch (error) {
    console.warn('Uventet fejl i fetchLiveSecForm4s:', error);
    return [];
  }
}

/**
 * On-demand SEC scanner for en specifik US ticker (f.eks. NVDA, PLTR, SOFI).
 * Slår CIK op, henter selskabets egne Form 4 filings, aggregerer del-handler og beriger med live kurs/nyheder.
 */
export async function scanTickerSecForm4s(ticker: string): Promise<InsiderTransaction[]> {
  const cleanTicker = ticker.trim().toUpperCase();
  const userAgent = process.env.SEC_USER_AGENT || 'InsiderOps/1.0 (mads.rosengaard2003@gmail.com)';

  const cikInfo = await getCikForTicker(cleanTicker, userAgent);
  if (!cikInfo) {
    console.warn(`Kunne ikke finde CIK nummer for tickeren '${cleanTicker}'`);
    return [];
  }

  const feedUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(
    cikInfo.cik
  )}&type=4&owner=only&count=15&output=atom`;

  try {
    const feedResponse = await fetch(feedUrl, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/atom+xml, application/xml, text/xml',
      },
    });

    if (!feedResponse.ok) {
      console.warn(`SEC Atom feed for ${cleanTicker} fejlede med status ${feedResponse.status}`);
      return [];
    }

    const feedXml = await feedResponse.text();
    const entryMatches = [...feedXml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];

    if (entryMatches.length === 0) {
      return [];
    }

    const transactions: InsiderTransaction[] = [];
    const BATCH_SIZE = 8;
    const entriesToProcess = entryMatches.slice(0, 12);

    for (let i = 0; i < entriesToProcess.length; i += BATCH_SIZE) {
      const chunk = entriesToProcess.slice(i, i + BATCH_SIZE);
      const chunkResults = await Promise.all(
        chunk.map((m) => parseForm4Entry(m[1], userAgent, cleanTicker, cikInfo.title))
      );

      for (const tx of chunkResults) {
        if (tx) transactions.push(tx);
      }
    }

    // Beregn sande cluster-køb med person-deduplikering
    applyTrueClusterDeduplication(transactions);

    // Berig transaktionerne med markedsdata og nyheder
    const passing = transactions.filter((tx) => applyHardFilter(tx).passed);
    const toEnrich = passing.length > 0 ? passing : transactions.slice(0, 3);
    await Promise.all(toEnrich.map((tx) => enrichTransactionWithMarketData(tx)));

    return transactions;
  } catch (error) {
    console.warn(`Fejl ved scanning af ticker ${cleanTicker}:`, error);
    return [];
  }
}

/**
 * Henter og udtrækker de juridiske fodnoter (<footnotes>) fra en Form 4 filing via SEC EDGAR.
 * Stripper automatisk eventuelle XSLT-stylesheets (/xslF345.../) for at hente den rå XML.
 */
export async function fetchSecForm4Footnotes(secUrl?: string): Promise<string[]> {
  if (!secUrl || !secUrl.includes('sec.gov')) {
    return [];
  }

  const userAgent = process.env.SEC_USER_AGENT || 'InsiderOps/1.0 (mads.rosengaard2003@gmail.com)';
  const cleanUrl = secUrl.replace(/\/xsl[^\/]+\//i, '/');

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(cleanUrl, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/xml, text/xml, text/html, */*',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return [];

    let text = await res.text();

    // Hvis det var et index-dokument i stedet for direkte XML, find XML-linket
    if (cleanUrl.endsWith('.htm') || cleanUrl.endsWith('.html') || !cleanUrl.endsWith('.xml')) {
      const xmlMatch = text.match(/href=["'](\/Archives\/edgar\/data\/[^"']+\.xml)["']/i);
      if (xmlMatch) {
        const rawXmlUrl = 'https://www.sec.gov' + xmlMatch[1].replace(/\/xsl[^\/]+\//i, '/');
        const xmlRes = await fetch(rawXmlUrl, {
          headers: { 'User-Agent': userAgent },
        });
        if (xmlRes.ok) {
          text = await xmlRes.text();
        }
      }
    }

    const footnotesBlock = text.match(/<footnotes>([\s\S]*?)<\/footnotes>/i);
    if (!footnotesBlock) {
      return [];
    }

    const matches = [...footnotesBlock[1].matchAll(/<footnote id=["']([^"']+)["']>([\s\S]*?)<\/footnote>/gi)];
    return matches
      .map((m) => {
        const id = m[1];
        const cleanText = m[2]
          .replace(/<[^>]+>/g, '')
          .replace(/&quot;/g, '"')
          .replace(/&apos;|&#39;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .replace(/\s+/g, ' ')
          .trim();
        return `[${id}] ${cleanText}`;
      })
      .filter((fn) => fn.length > 5);
  } catch (err) {
    console.warn(`Kunne ikke hente SEC fodnoter fra ${secUrl}:`, err);
    return [];
  }
}

