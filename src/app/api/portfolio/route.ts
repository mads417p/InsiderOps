import { NextResponse } from 'next/server';
import { getPaperPortfolio, savePaperTrade, deletePaperTrade, updateDb } from '@/lib/db';
import { fetchVerifiedLiveQuote, fetchLiveFxRates, getFxRateToDkk } from '@/lib/live-quote';
import {
  checkInsiderExitRadar,
  closePosition,
  computeSummaries,
  mergeExitWarning,
  refreshPosition,
  tradeTypeOf,
} from '@/lib/portfolio';
import { PaperTradePosition } from '@/types/insider';
import { idSchema, parseJson, portfolioPatchSchema, portfolioPostSchema } from '@/lib/api-schemas';

/** Live SPY-kurs eller null – aldrig en hårdkodet reserve (755 gav før permanent forkert alpha). */
async function fetchSpyPrice(): Promise<number | null> {
  try {
    const q = await fetchVerifiedLiveQuote('SPY');
    return q.price > 0 ? q.price : null;
  } catch (err) {
    console.warn('Kunne ikke hente live SPY-kurs:', err);
    return null;
  }
}

async function respondWithPortfolio(extra: Record<string, unknown> = {}) {
  const positions = Object.values(await getPaperPortfolio());
  const summaries = computeSummaries(positions);
  return NextResponse.json({
    success: true,
    count: positions.length,
    positions,
    summaries,
    summary: summaries.PAPER, // bagudkompatibelt felt; brug summaries
    fxRates: await fetchLiveFxRates(),
    ...extra,
  });
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const noRefresh = searchParams.get('refresh') === 'false';
    const checkExits = searchParams.get('checkExits') === 'true' || searchParams.get('refresh') === 'true';

    const positions = Object.values(await getPaperPortfolio());
    const openPositions = positions.filter((p) => p.status === 'OPEN');

    if (!noRefresh && openPositions.length > 0) {
      const [fx, spyPrice] = await Promise.all([fetchLiveFxRates(), fetchSpyPrice()]);
      const refreshed = await Promise.all(
        openPositions.map(async (pos) => {
          const [quote, exitCheck] = await Promise.all([
            fetchVerifiedLiveQuote(pos.ticker).catch(() => null),
            checkExits ? checkInsiderExitRadar(pos) : Promise.resolve(undefined),
          ]);
          const next = refreshPosition(pos, { quote, fx, spyPrice });
          next.insiderExitWarning = exitCheck
            ? mergeExitWarning(pos.insiderExitWarning, exitCheck)
            : pos.insiderExitWarning ?? { status: 'NOT_CHECKED', hasExit: false, message: 'Exit-radar ikke tjekket endnu' };
          return next;
        })
      );

      // Alle opdateringer i én skrivning. Slettede positioner genopstår ikke.
      // ponytail: en PATCH midt i kurshentningen (få sekunder) kan overskrives af refresh – merge pr. felt, hvis det bliver et problem.
      await updateDb((db) => {
        for (const pos of refreshed) {
          if (Object.hasOwn(db.paperPortfolio, pos.id)) db.paperPortfolio[pos.id] = pos;
        }
      });
    }

    return respondWithPortfolio();
  } catch (error) {
    console.error('Fejl i GET /api/portfolio:', error);
    return NextResponse.json(
      { success: false, error: `Kunne ikke hente porteføljen: ${(error as Error).message}` },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    // zod: asymmetryScore er påkrævet (ingen standard 85), tal skal være endelige og priser positive.
    const parsed = await parseJson(request, portfolioPostSchema);
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
    }
    const body = parsed.data;
    const insiderBuyPrice = body.insiderBuyPrice;
    if (body.id && Object.hasOwn(await getPaperPortfolio(), body.id)) {
      return NextResponse.json(
        { success: false, error: `Positionen ${body.id} findes allerede – den overskrives ikke` },
        { status: 409 }
      );
    }

    const ticker = body.ticker.toUpperCase();
    const [liveQuote, spyPrice, fxRates] = await Promise.all([
      fetchVerifiedLiveQuote(ticker),
      fetchSpyPrice(),
      fetchLiveFxRates(),
    ]);

    // Entry låses til en verificeret live kurs – aldrig en kurs fra klienten eller 1,0.
    if (!(liveQuote.price > 0)) {
      return NextResponse.json(
        { success: false, error: `Ingen live kurs for ${ticker} – positionen er ikke oprettet` },
        { status: 502 }
      );
    }
    const currentFxRateDkk = getFxRateToDkk(liveQuote.currency, fxRates);
    const usdDkk = getFxRateToDkk('USD', fxRates);
    if (currentFxRateDkk === undefined || usdDkk === undefined) {
      return NextResponse.json(
        { success: false, error: `Live valutakurs (${liveQuote.currency}/DKK eller USD/DKK) mangler – positionen er ikke oprettet` },
        { status: 502 }
      );
    }

    const entryPrice = liveQuote.price;
    let shares = body.shares ?? 0;
    if (!(shares > 0)) {
      const investedDkk = body.investedDkk ?? 0;
      if (!(investedDkk > 0)) {
        return NextResponse.json({ success: false, error: 'Angiv antal aktier eller beløb i DKK' }, { status: 400 });
      }
      shares = Math.floor(investedDkk / (entryPrice * currentFxRateDkk));
      if (shares < 1) {
        return NextResponse.json({ success: false, error: 'Beløbet rækker ikke til én aktie' }, { status: 400 });
      }
    }

    const position: PaperTradePosition = {
      id: body.id || `pos-${ticker.toLowerCase()}-${Date.now()}`,
      ticker,
      companyName: body.companyName || ticker,
      exchange: body.exchange || liveQuote.exchange || 'ukendt',
      insiderName: body.insiderName || 'ukendt',
      insiderTitle: body.insiderTitle || 'ukendt',
      asymmetryScore: body.asymmetryScore,
      openedScore: body.asymmetryScore, // kun her; PATCH-skemaet er strict og kender ikke feltet
      openedAt: new Date().toISOString(),
      insiderBuyPrice,
      entryPrice,
      currentPrice: entryPrice,
      entryFxRateDkk: currentFxRateDkk,
      currentFxRateDkk,
      entryUsdDkk: usdDkk,
      lastQuoteTime: liveQuote.lastQuoteTime,
      quoteSource: liveQuote.quoteSource,
      insiderPnlPct: Number((((entryPrice - insiderBuyPrice) / insiderBuyPrice) * 100).toFixed(2)),
      shares,
      investedDkk: Math.round(shares * entryPrice * currentFxRateDkk),
      stopLossPrice: body.stopLossPrice ?? 0,
      targetPrice: body.targetPrice ?? 0,
      pnlPct: 0,
      pnlDkk: 0,
      status: 'OPEN',
      tradeType: body.tradeType === 'REAL_NORDNET' ? 'REAL_NORDNET' : 'PAPER',
      benchmarkTicker: 'SPY',
      benchmarkEntryPrice: spyPrice ?? undefined, // null → alpha vises som "N/A"
      benchmarkCurrentPrice: spyPrice ?? undefined,
      benchmarkReturnPct: spyPrice ? 0 : null,
      alphaPct: spyPrice ? 0 : null,
      insiderExitWarning: { status: 'NOT_CHECKED', hasExit: false, message: 'Exit-radar ikke tjekket endnu' },
    };

    await savePaperTrade(position);
    return respondWithPortfolio({ position });
  } catch (error) {
    console.error('Fejl i POST /api/portfolio:', error);
    return NextResponse.json(
      { success: false, error: `Kunne ikke oprette positionen: ${(error as Error).message}` },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/portfolio
 * - { id, action: 'close', exitPrice? }: lukker positionen (CLOSED_MANUAL) med exit-kurs, exit-FX og realiseret P&L.
 *   Uden exitPrice bruges live kurs. Positionen slettes ikke.
 * - ellers: manuel redigering (entryPrice, shares, stopLossPrice, targetPrice, tradeType) for at matche Nordnet.
 */
export async function PATCH(request: Request) {
  try {
    const parsed = await parseJson(request, portfolioPatchSchema);
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
    }
    const body = parsed.data;
    const id = body.id;

    if ('action' in body && body.action === 'close') {
      const existing = await getPaperPortfolio();
      if (!Object.hasOwn(existing, id)) {
        return NextResponse.json({ success: false, error: 'Position ikke fundet i porteføljen' }, { status: 404 });
      }
      const [quote, fx] = await Promise.all([fetchVerifiedLiveQuote(existing[id].ticker), fetchLiveFxRates()]);
      const exitPrice = Number(body.exitPrice) > 0 ? Number(body.exitPrice) : quote.price;
      const exitFx = getFxRateToDkk(quote.currency, fx);
      if (!(exitPrice > 0) || exitFx === undefined) {
        return NextResponse.json(
          { success: false, error: 'Live kurs eller valutakurs mangler – positionen er ikke lukket. Angiv exitPrice manuelt.' },
          { status: 502 }
        );
      }
      const closed = await updateDb((db) => {
        if (!Object.hasOwn(db.paperPortfolio, id) || db.paperPortfolio[id].status !== 'OPEN') return null;
        db.paperPortfolio[id] = closePosition(db.paperPortfolio[id], exitPrice, exitFx, 'CLOSED_MANUAL');
        return db.paperPortfolio[id];
      });
      if (!closed) {
        return NextResponse.json({ success: false, error: 'Positionen er allerede lukket' }, { status: 409 });
      }
      return respondWithPortfolio({ position: closed });
    }

    const edit = body as Exclude<typeof body, { action: 'close' }>; // zod har valideret tal og enum

    // Hele read-modify-write sker i én updateDb, så samtidige skrivninger ikke overskriver hinanden.
    const pos = await updateDb((db) => {
      if (!Object.hasOwn(db.paperPortfolio, id)) return null;
      const pos = db.paperPortfolio[id];

      if (edit.tradeType !== undefined) pos.tradeType = edit.tradeType;
      if (edit.entryPrice !== undefined) pos.entryPrice = edit.entryPrice;
      if (edit.shares !== undefined) pos.shares = edit.shares;
      if (edit.stopLossPrice !== undefined) pos.stopLossPrice = edit.stopLossPrice;
      if (edit.targetPrice !== undefined) pos.targetPrice = edit.targetPrice;

      // Genberegn investering og P&L kun med gemte, målte valutakurser.
      if (pos.entryFxRateDkk > 0 && pos.currentFxRateDkk > 0) {
        pos.investedDkk = Math.round(pos.shares * pos.entryPrice * pos.entryFxRateDkk);
        pos.pnlDkk = Math.round(pos.shares * (pos.currentPrice * pos.currentFxRateDkk - pos.entryPrice * pos.entryFxRateDkk));
        pos.pnlPct = pos.investedDkk > 0 ? Number(((pos.pnlDkk / pos.investedDkk) * 100).toFixed(2)) : pos.pnlPct;
        if (typeof pos.benchmarkReturnPct === 'number') {
          pos.alphaPct = Number((pos.pnlPct - pos.benchmarkReturnPct).toFixed(2));
        }
      }
      // Rigtige positioner skifter aldrig status automatisk; kun en advarsel.
      if (tradeTypeOf(pos) === 'REAL_NORDNET' && pos.status === 'OPEN') {
        pos.priceAlert =
          pos.stopLossPrice > 0 && pos.currentPrice <= pos.stopLossPrice
            ? 'STOP'
            : pos.targetPrice > 0 && pos.currentPrice >= pos.targetPrice
              ? 'TARGET'
              : undefined;
      }
      return pos;
    });

    if (!pos) {
      return NextResponse.json({ success: false, error: 'Position ikke fundet i porteføljen' }, { status: 404 });
    }
    return respondWithPortfolio({ position: pos });
  } catch (error) {
    console.error('Fejl i PATCH /api/portfolio:', error);
    return NextResponse.json(
      { success: false, error: `Kunne ikke opdatere positionen: ${(error as Error).message}` },
      { status: 500 }
    );
  }
}

/** Sletter en fejloprettet position permanent. Almindelig lukning sker via PATCH action 'close'. */
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const parsedId = idSchema.safeParse(searchParams.get('id'));
    if (!parsedId.success) {
      return NextResponse.json({ success: false, error: 'Mangler eller ugyldigt id parameter' }, { status: 400 });
    }
    const deleted = await deletePaperTrade(parsedId.data);
    return respondWithPortfolio({ deleted });
  } catch (error) {
    console.error('Fejl i DELETE /api/portfolio:', error);
    return NextResponse.json({ success: false, error: 'Kunne ikke slette positionen' }, { status: 500 });
  }
}
