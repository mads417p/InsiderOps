import { NextResponse } from 'next/server';
import { getPaperPortfolio, savePaperTrade, deletePaperTrade } from '@/lib/db';
import { fetchVerifiedLiveQuote, fetchLiveFxRates, getFxRateToDkk } from '@/lib/live-quote';
import { PaperTradePosition, PortfolioSummary } from '@/types/insider';

function computeSummary(positions: PaperTradePosition[]): PortfolioSummary {
  const totalInvestedDkk = positions.reduce((sum, p) => sum + (p.investedDkk || 0), 0);
  const totalCurrentValueDkk = positions.reduce(
    (sum, p) =>
      sum +
      Math.round(
        p.shares * p.currentPrice * (p.currentFxRateDkk || p.entryFxRateDkk || 1.0)
      ),
    0
  );
  const totalPnlDkk = totalCurrentValueDkk - totalInvestedDkk;
  const totalPnlPct =
    totalInvestedDkk > 0 ? Number(((totalPnlDkk / totalInvestedDkk) * 100).toFixed(2)) : 0;
  const profitable = positions.filter((p) => (p.pnlDkk || 0) > 0).length;
  const winRatePct =
    positions.length > 0 ? Number(((profitable / positions.length) * 100).toFixed(1)) : 0;

  const openCount = positions.filter((p) => p.status === 'OPEN').length;
  const closedCount = positions.length - openCount;

  return {
    totalInvestedDkk,
    totalCurrentValueDkk,
    totalPnlDkk,
    totalPnlPct,
    winRatePct,
    openCount,
    closedCount,
  };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const noRefresh = searchParams.get('refresh') === 'false';

    const portfolioRecord = await getPaperPortfolio();
    const positions = Object.values(portfolioRecord);

    // Medmindre der eksplicit bedes om ingen refresh, hentes altid friske realtidskurser og live FX
    if (!noRefresh && positions.length > 0) {
      const openPositions = positions.filter((p) => p.status === 'OPEN');
      const fxRates = await fetchLiveFxRates();

      await Promise.all(
        openPositions.map(async (pos) => {
          try {
            const liveQuote = await fetchVerifiedLiveQuote(pos.ticker);
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
    const liveQuote = await fetchVerifiedLiveQuote(ticker);
    const fxRates = await fetchLiveFxRates();
    const currentFxRateDkk = getFxRateToDkk(liveQuote.currency, fxRates);

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
