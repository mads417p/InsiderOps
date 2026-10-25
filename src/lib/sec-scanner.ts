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
      currentMarketPrice: 22.8,
      returnSinceBuyPct: -5.0,
      isTradingBelowInsiderPrice: true,
      secFilingUrl: 'https://www.sec.gov/edgar/data/1029384/000102938426000042/form4.xml',
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
      recentPriceChange30dPct: -45.0,
      currentMarketPrice: 11.7,
      returnSinceBuyPct: -10.0,
      isTradingBelowInsiderPrice: true,
      secFilingUrl: 'https://www.sec.gov/edgar/data/1482910/000148291026000115/form4.xml',
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
      recentPriceChange30dPct: 3.5,
      currentMarketPrice: 34.1,
      returnSinceBuyPct: 10.0,
      isTradingBelowInsiderPrice: false,
      secFilingUrl: 'https://www.sec.gov/edgar/data/1129381/000112938126000089/form4.xml',
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
      secFilingUrl: 'https://www.sec.gov/edgar/data/1209384/000120938426000201/form4.xml',
      contextNotes:
        'Insider Salg (S) på $900.000 under 10b5-1 plan. Bliver filtreret fra, da vi udelukkende screener for købsasymmetri.',
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

    if (!ticker || !insiderName) return null;

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
      secFilingUrl: rawXmlUrl,
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
    const tableMatch = html.match(/<table[^>]*class=["']tinytable["'][\s\S]*?<\/table>/i);
    if (!tableMatch) return [];

    const trMatches = [...tableMatch[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)];
    const transactions: InsiderTransaction[] = [];

    for (let i = 1; i < trMatches.length; i++) {
      const rowHtml = trMatches[i][0];
      const tdMatches = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
      if (tdMatches.length < 13) continue;

      const filingDate = tdMatches[1].replace(/<[^>]+>/g, '').trim().split(' ')[0];
      const secLinkMatch = rowHtml.match(
        /href="(https?:\/\/(?:www\.)?sec\.gov\/Archives\/edgar\/data\/[^\s"'>]+)"/i
      );
      const secFilingUrl = secLinkMatch
        ? secLinkMatch[1].replace(/^http:/, 'https:')
        : 'https://www.sec.gov';

      const tickerMatch =
        tdMatches[3].match(/href="\/([A-Za-z0-9.\-]+)"/i) ||
        tdMatches[3].match(/>([A-Z0-9.\-]+)<\/a>/i);
      const ticker = tickerMatch ? tickerMatch[1].toUpperCase() : 'UNKNOWN';
      if (!ticker || ticker === 'UNKNOWN') continue;

      const companyName = tdMatches[4].replace(/<[^>]+>/g, '').trim();
      const insiderName = tdMatches[5].replace(/<[^>]+>/g, '').trim();
      const insiderTitle = tdMatches[6].replace(/<[^>]+>/g, '').trim() || 'Insider';

      const priceStr = tdMatches[8].replace(/<[^>]+>/g, '').replace(/[$,]/g, '').trim();
      const pricePerShare = parseFloat(priceStr) || 0;

      const qtyStr = tdMatches[9].replace(/<[^>]+>/g, '').replace(/[+,\s]/g, '').trim();
      const shares = parseInt(qtyStr, 10) || 0;

      const ownedStr = tdMatches[10].replace(/<[^>]+>/g, '').replace(/[,]/g, '').trim();
      const sharesOwnedFollowing = parseInt(ownedStr, 10) || 0;

      const deltaOwnStr = tdMatches[11].replace(/<[^>]+>/g, '').trim();
      let holdingsIncreasePct = 0;
      if (deltaOwnStr.toLowerCase().includes('new')) {
        holdingsIncreasePct = 100.0;
      } else {
        const clean = deltaOwnStr.replace(/[%,\s]/g, '').replace(/^\+/, '');
        holdingsIncreasePct = parseFloat(clean) || 0;
      }

      const valStr = tdMatches[12].replace(/<[^>]+>/g, '').replace(/[+$,\s]/g, '').trim();
      const totalValueUsd = parseFloat(valStr) || shares * pricePerShare;

      transactions.push({
        id: `live-buy-${ticker}-${filingDate}-${shares}-${Math.round(totalValueUsd)}`,
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
        secFilingUrl,
      });
    }

    // Detekter cluster buys inden for batchet
    const tickerCounts = new Map<string, number>();
    for (const t of transactions) {
      tickerCounts.set(t.ticker, (tickerCounts.get(t.ticker) || 0) + 1);
    }
    for (const t of transactions) {
      const count = tickerCounts.get(t.ticker) || 1;
      if (count > 1) {
        t.isClusterBuy = true;
        t.clusterCount = count;
      }
    }

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
 * Kombinerer den målrettede "Pure Kode P" Open-Market Purchase Hunter med det rå SEC EDGAR Atom feed.
 * Giver brugeren 10-15 ægte amerikanske åbne markedskøb over $50k og viser samtidig at Hard Filteret afviser støj.
 */
export async function fetchLiveSecForm4s(limit: number = 20): Promise<InsiderTransaction[]> {
  try {
    const [hunterResult, rawSecResult] = await Promise.allSettled([
      fetchHighConvictionOpenMarketBuys(15),
      fetchRawSecEdgarAtomFeed(8),
    ]);

    const hunterBuys = hunterResult.status === 'fulfilled' ? hunterResult.value : [];
    const rawFilings = rawSecResult.status === 'fulfilled' ? rawSecResult.value : [];

    const combined: InsiderTransaction[] = [];
    const seen = new Set<string>();

    for (const tx of [...hunterBuys, ...rawFilings]) {
      const key = `${tx.ticker}_${tx.filingDate}_${tx.shares}`;
      if (!seen.has(key)) {
        seen.add(key);
        combined.push(tx);
      }
    }

    if (combined.length === 0) {
      return getMockTransactions();
    }

    // Genberegn cluster counts
    const tickerCounts = new Map<string, number>();
    for (const tx of combined) {
      tickerCounts.set(tx.ticker, (tickerCounts.get(tx.ticker) || 0) + 1);
    }
    for (const tx of combined) {
      const count = tickerCounts.get(tx.ticker) || 1;
      if (count > 1) {
        tx.isClusterBuy = true;
        tx.clusterCount = count;
      }
    }

    return combined;
  } catch (error) {
    console.warn('Uventet fejl i fetchLiveSecForm4s, falder tilbage til mock-transaktioner:', error);
    return getMockTransactions();
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

    // Hvis der er flere transaktioner for denne ticker, marker som cluster
    if (transactions.length > 1) {
      for (const tx of transactions) {
        tx.isClusterBuy = true;
        tx.clusterCount = transactions.length;
      }
    }

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
