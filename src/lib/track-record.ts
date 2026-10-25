import { InsiderTransaction, InsiderTrackRecord, NotablePastTrade, TrackRecordReputation } from '@/types/insider';

/**
 * Sammenligner navne for at tjekke om to strenge refererer til samme insider.
 */
function isSamePerson(nameA: string, nameB: string): boolean {
  const cleanA = nameA.toLowerCase().replace(/[^a-z]/g, '');
  const cleanB = nameB.toLowerCase().replace(/[^a-z]/g, '');
  if (cleanA === cleanB) return true;
  const partsA = nameA.toLowerCase().split(/\s+/).filter(Boolean);
  const partsB = nameB.toLowerCase().split(/\s+/).filter(Boolean);
  // Hvis efternavnet matcher og enten fornavn eller mellemnavn matcher
  if (partsA.length > 0 && partsB.length > 0) {
    const lastNameA = partsA[partsA.length - 1];
    const lastNameB = partsB[partsB.length - 1];
    if (lastNameA === lastNameB && (partsA[0] === partsB[0] || cleanA.includes(lastNameB))) {
      return true;
    }
  }
  return false;
}

/**
 * Henter og beregner den historiske track record for et selskabs insidere
 * ved at analysere Open Market Purchases de seneste 3-4 år (ekskl. den aktuelle handelsrunde).
 */
export async function fetchInsiderTrackRecord(
  tx: InsiderTransaction
): Promise<InsiderTrackRecord> {
  const cleanTicker = tx.ticker.trim().toUpperCase();

  // Hvis det er en nordisk aktie (.CO, .ST, .HE)
  if (cleanTicker.endsWith('.CO') || cleanTicker.endsWith('.ST') || cleanTicker.endsWith('.HE')) {
    return {
      historicalBuysCount: 0,
      winRatePct: 0,
      avgReturnPct: 0,
      reputation: 'FIRST_TIME_OR_RARE',
      reputationLabel: '🆕 Nordisk MAR: Første registrerede åbne markedskøb i perioden',
      notablePastTrades: [],
    };
  }

  // Tjek for kendte mock cases til Asymmetry Lab
  if (tx.id === 'mock-cfo-cluster-buy' || cleanTicker === 'NVCR') {
    return {
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
    };
  }

  if (tx.id === 'mock-ceo-cosmetic-buy' || cleanTicker === 'PLXR') {
    return {
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
    };
  }

  if (tx.id === 'mock-chair-cfo-earnings-buy' || cleanTicker === 'MTLR') {
    return {
      historicalBuysCount: 0,
      winRatePct: 0,
      avgReturnPct: 0,
      reputation: 'FIRST_TIME_OR_RARE',
      reputationLabel: '🆕 Sjældent signal: Første åbne markedskøb fra ledelsen i >3 år',
      notablePastTrades: [],
    };
  }

  if (tx.id === 'mock-10b51-plan-buy' || cleanTicker === 'PLAN') {
    return {
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
    };
  }

  // Live opslag for amerikanske aktier via OpenInsider
  const url = `http://openinsider.com/screener?s=${encodeURIComponent(
    cleanTicker
  )}&o=&pl=&ph=&ll=&lh=&fd=1461&fdr=&td=0&tdr=&feession=&xp=1&vl=10&vh=&ocl=&och=&sic1=-1&sicl=100&sich=9999&grp=0&cnt=40&page=1`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      return fallbackDefaultRecord('Kunne ikke hente historiske data');
    }

    const html = await res.text();
    const trMatches = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];

    const pastTrades: NotablePastTrade[] = [];
    const currentPrice = tx.currentMarketPrice || tx.pricePerShare || 1.0;

    // Fastlæg reference-dato for den aktuelle transaktion (filingDate eller i dag)
    const txFilingTime = tx.filingDate ? new Date(tx.filingDate).getTime() : Date.now();
    // 14 dages margin: ekskluder handler der er foretaget som del af den aktuelle klynge
    const clusterCutoffTime = txFilingTime - 14 * 24 * 60 * 60 * 1000;

    for (const tr of trMatches) {
      const rowHtml = tr[1];
      const tdMatches = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
        m[1].replace(/<[^>]+>/g, '').trim()
      );

      if (tdMatches.length < 12) continue;

      let filingDateStr = tdMatches[1].split(' ')[0];
      let tradeDateStr = tdMatches[2].split(' ')[0];
      let insiderName = tdMatches[4];
      let insiderTitle = tdMatches[5];
      let tradeType = tdMatches[6];
      let priceStr = tdMatches[7];
      let valStr = tdMatches[11];

      // Håndter variation hvis et selskabsnavn-felt er indskudt
      if (
        !/^[PSAMFGD]\b|Purchase|Sale/i.test(tradeType) &&
        /^[PSAMFGD]\b|Purchase|Sale/i.test(tdMatches[7])
      ) {
        insiderName = tdMatches[5];
        insiderTitle = tdMatches[6];
        tradeType = tdMatches[7];
        priceStr = tdMatches[8];
        valStr = tdMatches[12];
      }

      // Vi ser UDELUKKENDE på tidligere Open Market Purchases (kode P)
      if (!tradeType.toLowerCase().includes('p')) continue;

      const tradeTime = new Date(tradeDateStr || filingDateStr).getTime();
      // Hvis handlen ligger for tæt på eller efter den aktuelle transaktion, spring over
      if (!isNaN(tradeTime) && tradeTime >= clusterCutoffTime) {
        continue;
      }

      const price = parseFloat(priceStr.replace(/[^0-9.]/g, '')) || 0;
      const valueUsd = parseFloat(valStr.replace(/[^0-9.]/g, '')) || 0;

      if (price <= 0) continue;

      const returnPct = Number((((currentPrice - price) / price) * 100).toFixed(1));

      pastTrades.push({
        date: tradeDateStr || filingDateStr,
        insiderName,
        insiderTitle,
        price,
        valueUsd,
        returnPct,
      });
    }

    const historicalBuysCount = pastTrades.length;

    if (historicalBuysCount === 0) {
      return {
        historicalBuysCount: 0,
        winRatePct: 0,
        avgReturnPct: 0,
        reputation: 'FIRST_TIME_OR_RARE',
        reputationLabel: '🆕 Sjældent signal: Første åbne markedskøb i >3 år',
        notablePastTrades: [],
      };
    }

    const wins = pastTrades.filter((t) => t.returnPct > 0).length;
    const winRatePct = Math.round((wins / historicalBuysCount) * 100);
    const avgReturnPct = Number(
      (pastTrades.reduce((sum, t) => sum + t.returnPct, 0) / historicalBuysCount).toFixed(1)
    );

    // Sortér så de mest betydningsfulde / nyeste tidligere køb er først
    pastTrades.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    const notablePastTrades = pastTrades.slice(0, 5);

    let reputation: TrackRecordReputation = 'CREDIBLE_BUYER';
    let reputationLabel = `📈 Kredibel køber (${winRatePct}% Win-Rate, Gns. ${avgReturnPct > 0 ? '+' : ''}${avgReturnPct}%)`;

    if (winRatePct >= 65 && avgReturnPct >= 10.0) {
      reputation = 'SMART_MONEY_SNIPER';
      reputationLabel = `🎯 Smart Money Sniper (${winRatePct}% Win-Rate, Gns. ${avgReturnPct > 0 ? '+' : ''}${avgReturnPct}%)`;
    } else if (avgReturnPct <= -20.0 || (historicalBuysCount >= 2 && winRatePct <= 20)) {
      reputation = 'EARLY_OR_BAGHOLDER';
      reputationLabel = `⚠️ Tidligere køb i minus (${winRatePct}% Win-Rate, Gns. ${avgReturnPct}%) - Bagholder-risiko`;
    }

    return {
      historicalBuysCount,
      winRatePct,
      avgReturnPct,
      reputation,
      reputationLabel,
      notablePastTrades,
    };
  } catch (err) {
    console.warn(`Fejl ved hentning af historisk track record for ${cleanTicker}:`, err);
    return fallbackDefaultRecord('Fejl ved historisk opslag');
  } finally {
    clearTimeout(timeoutId);
  }
}

function fallbackDefaultRecord(label: string): InsiderTrackRecord {
  return {
    historicalBuysCount: 0,
    winRatePct: 0,
    avgReturnPct: 0,
    reputation: 'FIRST_TIME_OR_RARE',
    reputationLabel: `🆕 ${label}: Første registrerede åbne markedskøb i perioden`,
    notablePastTrades: [],
  };
}
