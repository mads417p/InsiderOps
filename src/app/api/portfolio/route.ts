import { NextResponse } from 'next/server';
import { getPaperPortfolio, savePaperTrade, deletePaperTrade } from '@/lib/db';
import { fetchVerifiedLiveQuote, fetchLiveFxRates, getFxRateToDkk } from '@/lib/live-quote';
import { PaperTradePosition, PortfolioSummary } from '@/types/insider';

function computeSummary(positions: PaperTradePosition[]): PortfolioSummary {
  const totalInvestedDkk = positions.reduce((sum, p) => sum + (p.investedDkk || 0), 0);
  const totalPnlDkk = positions.reduce((sum, p) => sum + (p.pnlDkk || 0), 0);
  const totalCurrentValueDkk = totalInvestedDkk + totalPnlDkk;
  const totalPnlPct =
    totalInvestedDkk > 0 ? Number(((totalPnlDkk / totalInvestedDkk) * 100).toFixed(2)) : 0;
  const profitable = positions.filter((p) => (p.pnlDkk || 0) > 0).length;
  const winRatePct =
    positions.length > 0 ? Number(((profitable / positions.length) * 100).toFixed(1)) : 0;

  const openCount = positions.filter((p) => p.status === 'OPEN').length;
  const closedCount = positions.length - openCount;

  // Beregn vægtet gennemsnitlig Alpha og S&P 500 benchmark afkast
  let avgAlphaPct = 0;
  let benchmarkReturnPct = 0;

  if (totalInvestedDkk > 0) {
    avgAlphaPct = Number(
      positions
        .reduce((sum, p) => sum + (p.alphaPct || 0) * ((p.investedDkk || 0) / totalInvestedDkk), 0)
        .toFixed(2)
    );
    benchmarkReturnPct = Number(
      positions
        .reduce(
          (sum, p) => sum + (p.benchmarkReturnPct || 0) * ((p.investedDkk || 0) / totalInvestedDkk),
          0
        )
        .toFixed(2)
    );
  } else if (positions.length > 0) {
    avgAlphaPct = Number(
      (positions.reduce((sum, p) => sum + (p.alphaPct || 0), 0) / positions.length).toFixed(2)
    );
    benchmarkReturnPct = Number(
      (positions.reduce((sum, p) => sum + (p.benchmarkReturnPct || 0), 0) / positions.length).toFixed(2)
    );
  }

  return {
    totalInvestedDkk,
    totalCurrentValueDkk,
    totalPnlDkk,
    totalPnlPct,
    winRatePct,
    openCount,
    closedCount,
    avgAlphaPct,
    benchmarkReturnPct,
  };
}

/**
 * Tjekker OpenInsider for om der er registreret et reelt åbent markedssalg (Kode S)
 * fra en insider i samme aktie EFTER datoen hvor positionen blev åbnet.
 */
async function checkInsiderExitRadar(
  ticker: string,
  openedAt: string
): Promise<{
  hasExit: boolean;
  sellerName?: string;
  sellerTitle?: string;
  saleDate?: string;
  saleValueUsd?: number;
  message?: string;
}> {
  try {
    const cleanTicker = ticker.trim().toUpperCase();
    if (cleanTicker.includes('.')) {
      return {
        hasExit: false,
        message: 'Exit-radar kun aktiv for US-aktier via SEC',
      };
    }

    const openDateStr = openedAt.slice(0, 10);
    const url = `http://openinsider.com/screener?s=${encodeURIComponent(
      cleanTicker
    )}&o=&pl=&ph=&ll=&lh=&fd=30&fdr=&td=0&tdr=&feession=&xp=0&xs=1&vl=&vh=&ocl=&och=&sic1=-1&sicl=100&sich=9999&grp=0&cnt=10&page=1`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return { hasExit: false, message: 'Ingen insider-salg (Kode S) siden din entry' };
    }

    const html = await res.text();
    const rowMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];

    for (const row of rowMatches) {
      if (row.includes('S - Sale')) {
        const cells = (row.match(/<td[\s\S]*?<\/td>/gi) || []).map((c) =>
          c.replace(/<[^>]+>/g, '').trim()
        );
        if (cells.length >= 12) {
          const tradeDate = cells[2] || cells[1]?.slice(0, 10);
          if (tradeDate && tradeDate > openDateStr) {
            const sellerName = cells[4];
            const sellerTitle = cells[5] || 'Insider';
            const rawVal = cells[11] ? cells[11].replace(/[^\d]/g, '') : '0';
            const saleValueUsd = parseInt(rawVal, 10) || 0;

            return {
              hasExit: true,
              sellerName,
              sellerTitle,
              saleDate: tradeDate,
              saleValueUsd,
              message: `🚨 ADVARSEL: ${sellerName} (${sellerTitle}) solgte for $${saleValueUsd.toLocaleString()} USD den ${tradeDate}!`,
            };
          }
        }
      }
    }

    return {
      hasExit: false,
      message: 'Ingen insider-salg (Kode S) siden din entry',
    };
  } catch {
    return {
      hasExit: false,
      message: 'Ingen insider-salg (Kode S) siden din entry',
    };
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const noRefresh = searchParams.get('refresh') === 'false';
    const checkExits =
      searchParams.get('checkExits') === 'true' || searchParams.get('refresh') === 'true';

    const portfolioRecord = await getPaperPortfolio();
    const positions = Object.values(portfolioRecord);

    // Hent altid aktuel S&P 500 (SPY) referencekurs til Alpha-benchmarking
    let currentSpyPrice = 755.0;
    try {
      const spyQuote = await fetchVerifiedLiveQuote('SPY');
      if (spyQuote && spyQuote.price > 0) {
        currentSpyPrice = spyQuote.price;
      }
    } catch (spyErr) {
      console.warn('Kunne ikke hente live SPY benchmark kurs:', spyErr);
    }

    // Medmindre der eksplicit bedes om ingen refresh, hentes altid friske realtidskurser og live FX
    if (!noRefresh && positions.length > 0) {
      const openPositions = positions.filter((p) => p.status === 'OPEN');
      const fxRates = await fetchLiveFxRates();

      await Promise.all(
        openPositions.map(async (pos) => {
          try {
            // Kør live kursopdatering og insider exit radar parallelt
            const [liveQuote, exitWarning] = await Promise.all([
              fetchVerifiedLiveQuote(pos.ticker),
              checkExits
                ? checkInsiderExitRadar(pos.ticker, pos.openedAt)
                : Promise.resolve(pos.insiderExitWarning),
            ]);

            if (exitWarning) {
              pos.insiderExitWarning = exitWarning;
            }

            if (liveQuote && liveQuote.price > 0) {
              const currentFx = getFxRateToDkk(liveQuote.currency, fxRates);

              pos.currentPrice = liveQuote.price;
              pos.currentFxRateDkk = currentFx;
              if (!pos.entryFxRateDkk || pos.entryFxRateDkk <= 0) {
                pos.entryFxRateDkk = currentFx;
              }
              if (typeof pos.insiderBuyPrice !== 'number' || pos.insiderBuyPrice <= 0) {
                pos.insiderBuyPrice = pos.entryPrice;
              }

              // Sæt tradeType standard hvis ikke sat
              if (!pos.tradeType) {
                pos.tradeType = 'PAPER';
              }

              // S&P 500 (SPY) Alpha Benchmarking
              pos.benchmarkTicker = 'SPY';
              if (!pos.benchmarkEntryPrice || pos.benchmarkEntryPrice <= 0) {
                pos.benchmarkEntryPrice = currentSpyPrice;
              }
              pos.benchmarkCurrentPrice = currentSpyPrice;

              if (pos.benchmarkEntryPrice > 0) {
                pos.benchmarkReturnPct = Number(
                  (
                    ((pos.benchmarkCurrentPrice - pos.benchmarkEntryPrice) /
                      pos.benchmarkEntryPrice) *
                    100
                  ).toFixed(2)
                );
              } else {
                pos.benchmarkReturnPct = 0.0;
              }

              // Synkroniser investedDkk til formlen (shares * entryPrice * entryFxRateDkk)
              pos.investedDkk = Math.round(pos.shares * pos.entryPrice * pos.entryFxRateDkk);

              pos.lastQuoteTime = liveQuote.lastQuoteTime;
              pos.quoteSource = liveQuote.quoteSource;

              // 100% ærlig P&L beregning
              pos.pnlPct = Number(
                (((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2)
              );
              pos.pnlDkk = Math.round(
                pos.shares *
                  (pos.currentPrice * pos.currentFxRateDkk - pos.entryPrice * pos.entryFxRateDkk)
              );
              pos.insiderPnlPct =
                pos.insiderBuyPrice > 0
                  ? Number(
                      (((pos.currentPrice - pos.insiderBuyPrice) / pos.insiderBuyPrice) * 100).toFixed(
                        2
                      )
                    )
                  : 0;

              // Beregn præcis Alpha mod S&P 500
              pos.alphaPct = Number((pos.pnlPct - (pos.benchmarkReturnPct || 0)).toFixed(2));

              // Tjek for automatisk stop-loss eller kursmål aktivering
              if (pos.stopLossPrice > 0 && pos.currentPrice <= pos.stopLossPrice) {
                pos.status = 'STOPPED_OUT';
              } else if (pos.targetPrice > 0 && pos.currentPrice >= pos.targetPrice) {
                pos.status = 'TARGET_HIT';
              }

              await savePaperTrade(pos);
            }
          } catch (err) {
            console.warn(`Kunne ikke opdatere live kurs for ${pos.ticker}:`, err);
          }
        })
      );
    } else if (positions.length > 0) {
      // Sikr at benchmark og Alpha altid er beregnet, selv uden full refresh
      for (const pos of positions) {
        if (!pos.tradeType) pos.tradeType = 'PAPER';
        if (!pos.benchmarkTicker) pos.benchmarkTicker = 'SPY';
        if (!pos.benchmarkEntryPrice || pos.benchmarkEntryPrice <= 0) {
          pos.benchmarkEntryPrice = currentSpyPrice;
        }
        pos.benchmarkCurrentPrice = currentSpyPrice;
        if (pos.benchmarkEntryPrice > 0) {
          pos.benchmarkReturnPct = Number(
            (
              ((pos.benchmarkCurrentPrice - pos.benchmarkEntryPrice) /
                pos.benchmarkEntryPrice) *
              100
            ).toFixed(2)
          );
        }
        pos.alphaPct = Number(((pos.pnlPct || 0) - (pos.benchmarkReturnPct || 0)).toFixed(2));
      }
    }

    // Genindlæs efter opdatering
    const updatedRecord = await getPaperPortfolio();
    const updatedPositions = Object.values(updatedRecord);
    const summary = computeSummary(updatedPositions);
    const fxRates = await fetchLiveFxRates();

    return NextResponse.json({
      success: true,
      count: updatedPositions.length,
      positions: updatedPositions,
      summary,
      fxRates,
    });
  } catch (error) {
    console.error('Fejl i GET /api/portfolio:', error);
    return NextResponse.json(
      { success: false, error: 'Kunne ikke hente paper-trading porteføljen' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body.ticker) {
      return NextResponse.json(
        { success: false, error: 'Mangler påkrævet ticker felt' },
        { status: 400 }
      );
    }

    const ticker = body.ticker.toUpperCase().trim();

    // 1. Hent straks verificeret live markedskurs direkte fra CNBC + Yahoo
    const [liveQuote, spyQuote, fxRates] = await Promise.all([
      fetchVerifiedLiveQuote(ticker),
      fetchVerifiedLiveQuote('SPY').catch(() => null),
      fetchLiveFxRates(),
    ]);

    const currentFxRateDkk = getFxRateToDkk(liveQuote.currency, fxRates);
    const currentSpyPrice = spyQuote && spyQuote.price > 0 ? spyQuote.price : 755.0;

    // Hvis live quote returnerer gyldig kurs, lås til den!
    const verifiedEntryPrice =
      liveQuote.price > 0
        ? liveQuote.price
        : Number(body.entryPrice || body.currentPrice || body.pricePerShare || 1.0);

    const insiderBuyPrice = Number(
      body.insiderBuyPrice || body.pricePerShare || verifiedEntryPrice
    );

    // Bestem antal aktier og investeret beløb
    let shares = Number(body.shares);
    let investedDkk = Number(body.investedDkk);

    if (!shares || shares <= 0) {
      if (investedDkk > 0) {
        shares = Math.max(1, Math.floor(investedDkk / (verifiedEntryPrice * currentFxRateDkk)));
      } else {
        shares = 10;
      }
    }

    investedDkk = Math.round(shares * verifiedEntryPrice * currentFxRateDkk);

    const insiderPnlPct =
      insiderBuyPrice > 0
        ? Number((((verifiedEntryPrice - insiderBuyPrice) / insiderBuyPrice) * 100).toFixed(2))
        : 0;

    const position: PaperTradePosition = {
      id: body.id || `pos-${ticker.toLowerCase()}-${Date.now()}`,
      ticker,
      companyName: body.companyName || ticker,
      exchange: body.exchange || liveQuote.exchange || 'NASDAQ',
      insiderName: body.insiderName || 'Ledelsesmedlem',
      insiderTitle: body.insiderTitle || 'C-Suite',
      asymmetryScore: typeof body.asymmetryScore === 'number' ? body.asymmetryScore : 85,
      openedAt: body.openedAt || new Date().toISOString(),
      insiderBuyPrice,
      entryPrice: verifiedEntryPrice,
      currentPrice: verifiedEntryPrice,
      entryFxRateDkk: currentFxRateDkk,
      currentFxRateDkk: currentFxRateDkk,
      lastQuoteTime: liveQuote.lastQuoteTime || new Date().toISOString(),
      quoteSource: liveQuote.quoteSource || 'CNBC + Yahoo Real-Time Verified',
      insiderPnlPct,
      shares,
      investedDkk,
      stopLossPrice: Number(body.stopLossPrice || 0),
      targetPrice: Number(body.targetPrice || 0),
      pnlPct: 0.0, // Starter ALTID 100% ærligt på 0,00% ved åbning!
      pnlDkk: 0,   // Starter ALTID 100% ærligt på 0 kr. ved åbning!
      status: body.status || 'OPEN',
      tradeType: body.tradeType === 'REAL_NORDNET' ? 'REAL_NORDNET' : 'PAPER',
      benchmarkTicker: 'SPY',
      benchmarkEntryPrice: currentSpyPrice,
      benchmarkCurrentPrice: currentSpyPrice,
      benchmarkReturnPct: 0.0,
      alphaPct: 0.0,
      insiderExitWarning: {
        hasExit: false,
        message: 'Ingen insider-salg (Kode S) siden din entry',
      },
    };

    await savePaperTrade(position);

    const portfolioRecord = await getPaperPortfolio();
    const allPositions = Object.values(portfolioRecord);
    const summary = computeSummary(allPositions);

    return NextResponse.json({
      success: true,
      position,
      summary,
      fxRates,
    });
  } catch (error) {
    console.error('Fejl i POST /api/portfolio:', error);
    return NextResponse.json(
      { success: false, error: 'Kunne ikke oprette paper-trade position' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/portfolio: Manuel redigering af en position til at matche reelle Nordnet handler.
 * Opdaterer entryPrice, shares, stopLossPrice, targetPrice og tradeType ('PAPER' vs 'REAL_NORDNET').
 */
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const id = body.id;

    if (!id) {
      return NextResponse.json(
        { success: false, error: 'Mangler position id parameter' },
        { status: 400 }
      );
    }

    const portfolioRecord = await getPaperPortfolio();
    const pos = portfolioRecord[id];

    if (!pos) {
      return NextResponse.json(
        { success: false, error: 'Position ikke fundet i porteføljen' },
        { status: 404 }
      );
    }

    // 1. Opdater parametre hvis angivet
    if (body.tradeType !== undefined) {
      pos.tradeType = body.tradeType === 'REAL_NORDNET' ? 'REAL_NORDNET' : 'PAPER';
    }

    if (body.entryPrice !== undefined && Number(body.entryPrice) > 0) {
      pos.entryPrice = Number(body.entryPrice);
    }

    if (body.shares !== undefined && Number(body.shares) > 0) {
      pos.shares = Number(body.shares);
    }

    if (body.stopLossPrice !== undefined) {
      pos.stopLossPrice = Number(body.stopLossPrice);
    }

    if (body.targetPrice !== undefined) {
      pos.targetPrice = Number(body.targetPrice);
    }

    // 2. Genberegn investering og P&L baseret på de nye tal
    const entryFx = pos.entryFxRateDkk || 6.70;
    const currentFx = pos.currentFxRateDkk || entryFx;

    pos.investedDkk = Math.round(pos.shares * pos.entryPrice * entryFx);
    pos.pnlPct = Number((((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2));
    pos.pnlDkk = Math.round(
      pos.shares * (pos.currentPrice * currentFx - pos.entryPrice * entryFx)
    );

    // Genberegn Alpha hvis benchmark er kendt
    if (pos.benchmarkReturnPct !== undefined) {
      pos.alphaPct = Number((pos.pnlPct - pos.benchmarkReturnPct).toFixed(2));
    }

    // Tjek stop-loss / target
    if (pos.stopLossPrice > 0 && pos.currentPrice <= pos.stopLossPrice) {
      pos.status = 'STOPPED_OUT';
    } else if (pos.targetPrice > 0 && pos.currentPrice >= pos.targetPrice) {
      pos.status = 'TARGET_HIT';
    } else if (pos.status === 'STOPPED_OUT' || pos.status === 'TARGET_HIT') {
      pos.status = 'OPEN';
    }

    await savePaperTrade(pos);

    const updatedRecord = await getPaperPortfolio();
    const updatedPositions = Object.values(updatedRecord);
    const summary = computeSummary(updatedPositions);
    const fxRates = await fetchLiveFxRates();

    return NextResponse.json({
      success: true,
      position: pos,
      positions: updatedPositions,
      summary,
      fxRates,
    });
  } catch (error) {
    console.error('Fejl i PATCH /api/portfolio:', error);
    return NextResponse.json(
      { success: false, error: 'Kunne ikke opdatere positionen' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { success: false, error: 'Mangler id parameter' },
        { status: 400 }
      );
    }

    const deleted = await deletePaperTrade(id);

    const portfolioRecord = await getPaperPortfolio();
    const allPositions = Object.values(portfolioRecord);
    const summary = computeSummary(allPositions);

    return NextResponse.json({
      success: true,
      deleted,
      summary,
    });
  } catch (error) {
    console.error('Fejl i DELETE /api/portfolio:', error);
    return NextResponse.json(
      { success: false, error: 'Kunne ikke lukke positionen' },
      { status: 500 }
    );
  }
}
