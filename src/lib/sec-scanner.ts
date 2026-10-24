import { InsiderTransaction, TransactionCode } from '@/types/insider';

/**
 * Trin 2: Hård filtrering uden API-omkostninger.
 * Afviser handler, der ikke er åbne markedskøb (kode 'P') eller under $50.000 USD.
 */
export function applyHardFilter(tx: InsiderTransaction): { passed: boolean; reason?: string } {
  if (tx.transactionCode !== 'P') {
    return {
      passed: false,
      reason: `Afvist: Transaktionskode er '${tx.transactionCode}'. Kun åbne markedskøb (kode 'P') for egne midler analyseres.`,
    };
  }

  if (tx.totalValueUsd < 50000) {
    return {
      passed: false,
      reason: `Afvist: Samlet værdi ($${Math.round(tx.totalValueUsd).toLocaleString()}) er under minimumsgrænsen på $50.000 for asymmetrisk signal.`,
    };
  }

  return { passed: true };
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
      recentPriceChange30dPct: -28.0,
      secFilingUrl: 'https://www.sec.gov/edgar/data/1029384/000102938426000042/form4.xml',
      contextNotes:
        'Massivt CFO + General Counsel cluster-køb efter 28% kursfald grundet forsinket FDA-møde. Forøger CFOs beholdning med 42% ($480k).',
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
      recentPriceChange30dPct: -45.0,
      secFilingUrl: 'https://www.sec.gov/edgar/data/1482910/000148291026000115/form4.xml',
      contextNotes:
        'CEO "Cosmetic / PR Buy" i presset selskab. Køb for $65k er mikroskopisk mod en eksisterende beholdning på $18 mio. (kun +0.36% forøgelse).',
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
      recentPriceChange30dPct: 3.5,
      secFilingUrl: 'https://www.sec.gov/edgar/data/1129381/000112938126000089/form4.xml',
      contextNotes:
        'Stille Bestyrelsesformand + CFO køb ($310.000, +28% beholdning) i overset industriaktie to uger før kvartalsregnskab.',
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
      secFilingUrl: 'https://www.sec.gov/edgar/data/1209384/000120938426000201/form4.xml',
      contextNotes:
        'Insider Salg (S) på $900.000 under 10b5-1 plan. Bliver filtreret fra, da vi udelukkende screener for købsasymmetri.',
    },
  ];
}

/**
 * Henter seneste Form 4 filings fra SEC EDGAR Atom/XML feedet og parser til InsiderTransaction.
 * Falder graceful tilbage til mock data ved netværksfejl, tomme feeds eller SEC rate-limits.
 */
export async function fetchLiveSecForm4s(limit: number = 10): Promise<InsiderTransaction[]> {
  const userAgent = process.env.SEC_USER_AGENT || 'InsiderOps mads@example.com';
  const feedUrl =
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=only&start=0&count=20&output=atom';

  try {
    const feedResponse = await fetch(feedUrl, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/atom+xml, application/xml, text/xml',
      },
    });

    if (!feedResponse.ok) {
      console.warn(`SEC EDGAR feed returnerede status ${feedResponse.status}. Falder tilbage til mock-transaktioner.`);
      return getMockTransactions();
    }

    const feedXml = await feedResponse.text();
    const entryMatches = [...feedXml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];

    if (!entryMatches || entryMatches.length === 0) {
      console.warn('Ingen entries fundet i SEC feed. Falder tilbage til mock-transaktioner.');
      return getMockTransactions();
    }

    const transactions: InsiderTransaction[] = [];
    const entriesToProcess = entryMatches.slice(0, Math.min(limit, 10));

    for (const match of entriesToProcess) {
      const entryContent = match[1];
      const linkMatch = entryContent.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (!linkMatch) continue;

      let indexUrl = linkMatch[1];
      if (!indexUrl.startsWith('http')) {
        indexUrl = 'https://www.sec.gov' + indexUrl;
      }

      try {
        const indexResponse = await fetch(indexUrl, {
          headers: { 'User-Agent': userAgent },
        });

        if (!indexResponse.ok) continue;

        const indexHtml = await indexResponse.text();
        const xmlMatch = indexHtml.match(/href=["'](\/Archives\/edgar\/data\/[^"']+\.xml)["']/i);
        if (!xmlMatch) continue;

        // Strip stylesheet prefix (f.eks. /xslF345X06/) for at få den rå XML-fil
        const rawXmlPath = xmlMatch[1].replace(/\/xsl[^\/]+\//i, '/');
        const rawXmlUrl = 'https://www.sec.gov' + rawXmlPath;

        const xmlResponse = await fetch(rawXmlUrl, {
          headers: { 'User-Agent': userAgent },
        });

        if (!xmlResponse.ok) continue;

        const xml = await xmlResponse.text();

        // Udtræk kerne-felter via regex
        const ticker = xml.match(/<issuerTradingSymbol>\s*(.*?)\s*<\/issuerTradingSymbol>/i)?.[1]?.trim();
        const companyName = xml.match(/<issuerName>\s*(.*?)\s*<\/issuerName>/i)?.[1]?.trim();
        const insiderName = xml.match(/<rptOwnerName>\s*(.*?)\s*<\/rptOwnerName>/i)?.[1]?.trim();
        const rawCode = xml.match(/<transactionCode>\s*(.*?)\s*<\/transactionCode>/i)?.[1]?.trim() as TransactionCode;

        if (!ticker || !insiderName || !rawCode) continue;

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

        const sharesStr = xml.match(/<transactionShares>\s*<value>\s*(.*?)\s*<\/value>/i)?.[1]?.trim();
        const priceStr = xml.match(/<transactionPricePerShare>\s*<value>\s*(.*?)\s*<\/value>/i)?.[1]?.trim();
        const ownedFollowingStr = xml.match(
          /<sharesOwnedFollowingTransaction>\s*<value>\s*(.*?)\s*<\/value>/i
        )?.[1]?.trim();

        const shares = parseFloat(sharesStr || '0');
        const pricePerShare = parseFloat(priceStr || '0');
        const totalValueUsd = shares * pricePerShare;
        const sharesOwnedFollowing = parseFloat(ownedFollowingStr || '0');

        const priorShares = sharesOwnedFollowing - shares;
        const holdingsIncreasePct =
          priorShares > 0 ? parseFloat(((shares / priorShares) * 100).toFixed(2)) : 100.0;

        const validTransactionCode: TransactionCode = ['P', 'S', 'A', 'M'].includes(rawCode)
          ? rawCode
          : 'P';

        const transaction: InsiderTransaction = {
          id: `sec-${ticker}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          filingDate,
          ticker,
          companyName: companyName || ticker,
          insiderName,
          insiderTitle,
          transactionCode: validTransactionCode,
          shares,
          pricePerShare,
          totalValueUsd,
          sharesOwnedFollowing,
          holdingsIncreasePct,
          isClusterBuy: false, // Beregnes efterfølgende på tværs af batch
          clusterCount: 1,
          secFilingUrl: rawXmlUrl,
        };

        transactions.push(transaction);
      } catch (err) {
        console.warn(`Fejl ved hentning af individuel Form 4 (${indexUrl}):`, err);
      }
    }

    // Hvis ingen gyldige transaktioner blev fundet, brug mock data
    if (transactions.length === 0) {
      return getMockTransactions();
    }

    // Beregn cluster buy på tværs af de fundne transaktioner
    const tickerCounts = transactions.reduce<Record<string, number>>((acc, tx) => {
      acc[tx.ticker] = (acc[tx.ticker] || 0) + 1;
      return acc;
    }, {});

    for (const tx of transactions) {
      const count = tickerCounts[tx.ticker] || 1;
      if (count > 1) {
        tx.isClusterBuy = true;
        tx.clusterCount = count;
      }
    }

    return transactions;
  } catch (error) {
    console.warn('Uventet fejl i fetchLiveSecForm4s, falder tilbage til mock-transaktioner:', error);
    return getMockTransactions();
  }
}
