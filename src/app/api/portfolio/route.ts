import { NextResponse } from 'next/server';
import { getPaperPortfolio, savePaperTrade, deletePaperTrade } from '@/lib/db';
import { fetchMarketPrices } from '@/lib/market-enricher';
import { PaperTradePosition, PortfolioSummary } from '@/types/insider';

function computeSummary(positions: PaperTradePosition[]): PortfolioSummary {
  const totalInvestedDkk = positions.reduce((sum, p) => sum + p.investedDkk, 0);
  const totalCurrentValueDkk = positions.reduce(
    (sum, p) => sum + Math.round(p.investedDkk * (1 + p.pnlPct / 100)),
    0
  );
  const totalPnlDkk = totalCurrentValueDkk - totalInvestedDkk;
  const totalPnlPct =
    totalInvestedDkk > 0 ? Number(((totalPnlDkk / totalInvestedDkk) * 100).toFixed(2)) : 0;
  const profitable = positions.filter((p) => p.pnlDkk > 0).length;
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
    const refresh = searchParams.get('refresh') === 'true';

    const portfolioRecord = await getPaperPortfolio();
    const positions = Object.values(portfolioRecord);

    if (refresh && positions.length > 0) {
      // Hent opdaterede live kurser for åbne positioner via Yahoo Finance
      const openPositions = positions.filter((p) => p.status === 'OPEN');

      await Promise.all(
        openPositions.map(async (pos) => {
          try {
            const mkt = await fetchMarketPrices(pos.ticker);
            if (mkt && mkt.currentPrice > 0) {
              pos.currentPrice = mkt.currentPrice;
              pos.pnlPct = Number(
                (((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2)
              );
              pos.pnlDkk = Math.round(pos.investedDkk * (pos.pnlPct / 100));

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

    return NextResponse.json({
      success: true,
      count: updatedPositions.length,
      positions: updatedPositions,
      summary,
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

    if (!body.ticker || !body.investedDkk || !body.shares || !body.entryPrice) {
      return NextResponse.json(
        { success: false, error: 'Mangler påkrævede felter (ticker, investedDkk, shares, entryPrice)' },
        { status: 400 }
      );
    }

    const currentPrice = body.currentPrice || body.entryPrice;
    const pnlPct = Number((((currentPrice - body.entryPrice) / body.entryPrice) * 100).toFixed(2));
    const pnlDkk = Math.round(body.investedDkk * (pnlPct / 100));

    const position: PaperTradePosition = {
      id: body.id || `pos-${body.ticker.toLowerCase()}-${Date.now()}`,
      ticker: body.ticker.toUpperCase(),
      companyName: body.companyName || body.ticker,
      exchange: body.exchange || 'NASDAQ',
      insiderName: body.insiderName || 'Ledelsesmedlem',
      insiderTitle: body.insiderTitle || 'C-Suite',
      asymmetryScore: typeof body.asymmetryScore === 'number' ? body.asymmetryScore : 85,
      openedAt: body.openedAt || new Date().toISOString(),
      entryPrice: Number(body.entryPrice),
      currentPrice: Number(currentPrice),
      shares: Number(body.shares),
      investedDkk: Number(body.investedDkk),
      stopLossPrice: Number(body.stopLossPrice || 0),
      targetPrice: Number(body.targetPrice || 0),
      pnlPct,
      pnlDkk,
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
