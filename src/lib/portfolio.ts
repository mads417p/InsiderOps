import {
  ExitSale,
  InsiderExitWarning,
  PaperTradePosition,
  PaperTradeStatus,
  PortfolioSummary,
  RealKpis,
  TradeType,
} from '@/types/insider';
import type { CostsConfig } from '@/lib/costs';
import { orderCostDkk } from '@/lib/round-trip';
import { currencyForTicker, getFxRateToDkk, type LiveFxRates } from '@/lib/live-quote';
import { detect10b51, fetchOpenInsiderHtml, parseOpenInsiderTable } from '@/lib/sec-scanner';
import { secFetch } from '@/lib/sec-client';

const round2 = (n: number) => Number(n.toFixed(2));
export const tradeTypeOf = (p: PaperTradePosition): TradeType => p.tradeType ?? 'PAPER';

/**
 * Alpha i DKK: positionens afkast i DKK minus SPY's afkast i DKK i samme periode (i procentpoint).
 * Begge sider omregnes med valutakursen ved entry og nu. Mangler et tal, er resultatet null ("N/A").
 */
export function computeAlphaDkk(a: {
  entryPrice: number;
  entryFx?: number;
  price: number;
  fxNow?: number;
  spyEntry?: number;
  usdDkkEntry?: number;
  spyNow?: number | null;
  usdDkkNow?: number;
}): { positionReturnPct: number | null; benchmarkReturnPct: number | null; alphaPct: number | null } {
  const ok = (n?: number | null): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  const positionReturnPct =
    ok(a.entryPrice) && ok(a.entryFx) && ok(a.price) && ok(a.fxNow)
      ? round2(((a.price * a.fxNow) / (a.entryPrice * a.entryFx) - 1) * 100)
      : null;
  const benchmarkReturnPct =
    ok(a.spyEntry) && ok(a.usdDkkEntry) && ok(a.spyNow) && ok(a.usdDkkNow)
      ? round2(((a.spyNow * a.usdDkkNow) / (a.spyEntry * a.usdDkkEntry) - 1) * 100)
      : null;
  const alphaPct =
    positionReturnPct !== null && benchmarkReturnPct !== null ? round2(positionReturnPct - benchmarkReturnPct) : null;
  return { positionReturnPct, benchmarkReturnPct, alphaPct };
}

/** Lukker en position uden at slette den: exit-kurs, exit-FX, tidspunkt og realiseret P&L i DKK gemmes. */
export function closePosition(
  pos: PaperTradePosition,
  exitPrice: number,
  exitFx: number,
  status: Exclude<PaperTradeStatus, 'OPEN'>,
  closedAt = new Date().toISOString(),
  bench?: { spyNow: number | null; usdDkkNow?: number }
): PaperTradePosition {
  const invested = pos.shares * pos.entryPrice * pos.entryFxRateDkk;
  const realizedPnlDkk = Math.round(pos.shares * (exitPrice * exitFx - pos.entryPrice * pos.entryFxRateDkk));
  // Alpha på lukketidspunktet, når SPY er hentet samtidig med exit-kursen; ellers beholdes sidste refresh-værdi.
  const a = bench
    ? computeAlphaDkk({
        entryPrice: pos.entryPrice,
        entryFx: pos.entryFxRateDkk,
        price: exitPrice,
        fxNow: exitFx,
        spyEntry: pos.benchmarkEntryPrice,
        usdDkkEntry: pos.entryUsdDkk,
        spyNow: bench.spyNow,
        usdDkkNow: bench.usdDkkNow,
      })
    : null;
  return {
    ...pos,
    ...(a?.alphaPct != null && {
      benchmarkCurrentPrice: bench!.spyNow ?? undefined,
      benchmarkReturnPct: a.benchmarkReturnPct,
      alphaPct: a.alphaPct,
    }),
    status,
    exitPrice,
    exitFx,
    closedAt,
    currentPrice: exitPrice,
    currentFxRateDkk: exitFx,
    realizedPnlDkk,
    realizedPnlPct: invested > 0 ? round2((realizedPnlDkk / invested) * 100) : undefined,
    pnlDkk: realizedPnlDkk,
    pnlPct: invested > 0 ? round2((realizedPnlDkk / invested) * 100) : pos.pnlPct,
    priceAlert: undefined,
  };
}

/**
 * Opdaterer en åben position med live kurs, FX og SPY (ren funktion).
 * - P&L og afkast i DKK; alpha mod SPY i DKK (null, hvis benchmark eller FX mangler).
 * - PAPER: stop/target lukker positionen (STOPPED_OUT/TARGET_HIT med exit-felter).
 * - REAL_NORDNET: status ændres aldrig automatisk – der sættes kun priceAlert.
 * Uden live kurs eller valutakurs returneres positionen uændret.
 */
export function refreshPosition(
  pos: PaperTradePosition,
  ctx: {
    quote: { price: number; currency?: string; lastQuoteTime?: string; quoteSource?: string } | null;
    fx: LiveFxRates | null;
    spyPrice: number | null;
  }
): PaperTradePosition {
  if (pos.status !== 'OPEN') return pos;
  const price = ctx.quote?.price;
  const fxNow = getFxRateToDkk(ctx.quote?.currency || currencyForTicker(pos.ticker), ctx.fx);
  if (!(price && price > 0) || fxNow === undefined || !(pos.entryFxRateDkk > 0)) return pos;

  const investedDkk = Math.round(pos.shares * pos.entryPrice * pos.entryFxRateDkk);
  const pnlDkk = Math.round(pos.shares * (price * fxNow - pos.entryPrice * pos.entryFxRateDkk));
  const { positionReturnPct, benchmarkReturnPct, alphaPct } = computeAlphaDkk({
    entryPrice: pos.entryPrice,
    entryFx: pos.entryFxRateDkk,
    price,
    fxNow,
    spyEntry: pos.benchmarkEntryPrice,
    usdDkkEntry: pos.entryUsdDkk,
    spyNow: ctx.spyPrice,
    usdDkkNow: getFxRateToDkk('USD', ctx.fx),
  });

  let next: PaperTradePosition = {
    ...pos,
    tradeType: tradeTypeOf(pos),
    currentPrice: price,
    currentFxRateDkk: fxNow,
    lastQuoteTime: ctx.quote?.lastQuoteTime || pos.lastQuoteTime,
    quoteSource: ctx.quote?.quoteSource || pos.quoteSource,
    investedDkk,
    pnlDkk,
    pnlPct: positionReturnPct ?? pos.pnlPct,
    insiderPnlPct: pos.insiderBuyPrice > 0 ? round2(((price - pos.insiderBuyPrice) / pos.insiderBuyPrice) * 100) : pos.insiderPnlPct,
    benchmarkTicker: 'SPY',
    benchmarkCurrentPrice: ctx.spyPrice ?? undefined,
    benchmarkReturnPct,
    alphaPct,
  };

  const stopHit = pos.stopLossPrice > 0 && price <= pos.stopLossPrice;
  const targetHit = pos.targetPrice > 0 && price >= pos.targetPrice;
  if (tradeTypeOf(pos) === 'REAL_NORDNET') {
    // Rigtige positioner: ingen ordre er udført – vis kun en advarsel.
    next.priceAlert = stopHit ? 'STOP' : targetHit ? 'TARGET' : undefined;
  } else if (stopHit) {
    next = closePosition(next, price, fxNow, 'STOPPED_OUT');
  } else if (targetHit) {
    next = closePosition(next, price, fxNow, 'TARGET_HIT');
  }
  return next;
}

/**
 * KPI'er for én handelstype (PAPER og REAL_NORDNET blandes aldrig).
 * Win rate tæller kun lukkede positioner (null uden lukkede); alpha vægtes over åbne positioner med kendt benchmark.
 */
export function computeSummary(positions: PaperTradePosition[], tradeType: TradeType): PortfolioSummary {
  const mine = positions.filter((p) => tradeTypeOf(p) === tradeType);
  const open = mine.filter((p) => p.status === 'OPEN');
  const closed = mine.filter((p) => p.status !== 'OPEN');

  const totalInvestedDkk = open.reduce((s, p) => s + (p.investedDkk || 0), 0);
  const unrealizedPnlDkk = open.reduce((s, p) => s + (p.pnlDkk || 0), 0);
  const realizedPnlDkk = closed.reduce((s, p) => s + (p.realizedPnlDkk ?? p.pnlDkk ?? 0), 0);
  const allInvested = mine.reduce((s, p) => s + (p.investedDkk || 0), 0);
  const totalPnlDkk = unrealizedPnlDkk + realizedPnlDkk;

  const wins = closed.filter((p) => (p.realizedPnlDkk ?? p.pnlDkk ?? 0) > 0).length;

  const withAlpha = open.filter((p) => typeof p.alphaPct === 'number' && typeof p.benchmarkReturnPct === 'number');
  const alphaWeight = withAlpha.reduce((s, p) => s + (p.investedDkk || 0), 0);
  const weighted = (f: (p: PaperTradePosition) => number) =>
    alphaWeight > 0 ? round2(withAlpha.reduce((s, p) => s + f(p) * (p.investedDkk || 0), 0) / alphaWeight) : null;

  return {
    tradeType,
    totalInvestedDkk,
    totalCurrentValueDkk: totalInvestedDkk + unrealizedPnlDkk,
    unrealizedPnlDkk,
    realizedPnlDkk,
    totalPnlDkk,
    totalPnlPct: allInvested > 0 ? round2((totalPnlDkk / allInvested) * 100) : 0,
    winRatePct: closed.length > 0 ? Number(((wins / closed.length) * 100).toFixed(1)) : null,
    openCount: open.length,
    closedCount: closed.length,
    avgAlphaPct: weighted((p) => p.alphaPct as number),
    benchmarkReturnPct: weighted((p) => p.benchmarkReturnPct as number),
  };
}

/**
 * Egne KPI'er for REAL_NORDNET (fase 9) – virker mine copy trades?
 * Omkostninger = Nordnet-tarif fra costs.json (kurtage + veksling) for købet og, for lukkede, salget.
 * Spread tælles ikke: den ligger i de faktiske kurser, når de er rettet til Nordnet. Salg af åbne
 * positioner er ikke betalt endnu og indgår ikke.
 */
export function computeRealKpis(positions: PaperTradePosition[], costs: CostsConfig): RealKpis {
  const mine = positions.filter((p) => tradeTypeOf(p) === 'REAL_NORDNET');
  const closed = mine.filter((p) => p.status !== 'OPEN');
  let costsDkk = 0;
  let costsMissing = 0;
  for (const p of mine) {
    const cur = currencyForTicker(p.ticker);
    const buy = orderCostDkk(costs, cur, p.shares * p.entryPrice * p.entryFxRateDkk);
    const sell =
      p.status === 'OPEN' ? 0 : p.exitPrice && p.exitFx ? orderCostDkk(costs, cur, p.shares * p.exitPrice * p.exitFx) : undefined;
    if (buy === undefined || sell === undefined) costsMissing++;
    else costsDkk += buy + sell;
  }
  const investedDkk = Math.round(mine.reduce((s, p) => s + p.shares * p.entryPrice * p.entryFxRateDkk, 0));
  const grossPnlDkk = mine.reduce((s, p) => s + (p.status === 'OPEN' ? p.pnlDkk || 0 : p.realizedPnlDkk ?? p.pnlDkk ?? 0), 0);
  const netPnlDkk = Math.round(grossPnlDkk - costsDkk);
  const withAlpha = mine.filter((p) => typeof p.alphaPct === 'number' && p.investedDkk > 0);
  const w = withAlpha.reduce((s, p) => s + p.investedDkk, 0);
  return {
    openCount: mine.length - closed.length,
    closedCount: closed.length,
    investedDkk,
    grossPnlDkk,
    costsDkk: Math.round(costsDkk),
    costsMissing,
    netPnlDkk,
    netPnlPct: investedDkk > 0 ? round2((netPnlDkk / investedDkk) * 100) : null,
    alphaPct: w > 0 ? round2(withAlpha.reduce((s, p) => s + (p.alphaPct as number) * p.investedDkk, 0) / w) : null,
    alphaCount: withAlpha.length,
  };
}

export function computeSummaries(positions: PaperTradePosition[]): Record<TradeType, PortfolioSummary> {
  return { PAPER: computeSummary(positions, 'PAPER'), REAL_NORDNET: computeSummary(positions, 'REAL_NORDNET') };
}

/**
 * Fletter et nyt radar-tjek med det forrige: den første alarm gemmes permanent, så den ikke forsvinder
 * ved næste refresh (fx når salget falder ud af OpenInsider-vinduet).
 */
export function mergeExitWarning(prev: InsiderExitWarning | undefined, next: InsiderExitWarning): InsiderExitWarning {
  if (prev?.firstAlertAt && prev.firstAlert) {
    const f = prev.firstAlert;
    return {
      ...next,
      hasExit: true,
      firstAlertAt: prev.firstAlertAt,
      firstAlert: f,
      message: `Første alarm (${prev.firstAlertAt.slice(0, 10)}): ${f.name} (${f.title}) solgte for $${f.valueUsd.toLocaleString('en-US')} den ${f.date}. Seneste tjek: ${next.message ?? next.status}`,
    };
  }
  return next;
}

const SALE_KIND_LABEL: Record<ExitSale['kind'], string> = {
  DISCRETIONARY: 'frivilligt salg',
  PLAN_10B5_1: 'under 10b5-1-plan',
  TEN_PCT_OWNER: '10 %-ejer',
  UNKNOWN: '10b5-1 ikke afklaret',
};

/**
 * Exit-radar: insider-salg (kode S) i aktien siden positionen blev åbnet – uden rækkeloft.
 * Hvert salg klassificeres via sin Form 4 (10b5-1) og titlen (10 %-ejer). Kun frivillige eller uafklarede
 * salg udløser alarm. Fejl giver status ERROR – aldrig "0 salg".
 */
export async function checkInsiderExitRadar(
  pos: Pick<PaperTradePosition, 'ticker' | 'openedAt'>,
  now = new Date()
): Promise<InsiderExitWarning> {
  const checkedAt = now.toISOString();
  const ticker = pos.ticker.trim().toUpperCase();
  if (ticker.includes('.')) {
    return { status: 'UNSUPPORTED', hasExit: false, checkedAt, message: 'Exit-radar dækker kun US-aktier (SEC Form 4)' };
  }
  try {
    const openDate = pos.openedAt.slice(0, 10);
    const days = Math.max(1, Math.ceil((now.getTime() - Date.parse(openDate)) / 86_400_000) + 1);
    const html = await fetchOpenInsiderHtml(`s=${encodeURIComponent(ticker)}&o=&fd=${days}&fdr=&td=0&tdr=&xp=0&xs=1&vl=&vh=&sortcol=0&cnt=1000&page=1`);
    const rows = parseOpenInsiderTable(html, 'exit').filter(
      (r) => r.transactionCode === 'S' && r.ticker.toUpperCase() === ticker && (r.tradeDate ?? '') >= openDate
    );

    const sales: ExitSale[] = [];
    for (const r of rows) {
      let kind: ExitSale['kind'] = 'UNKNOWN';
      if (/(?<![\p{L}\p{N}])10%/u.test(r.insiderTitle)) {
        kind = 'TEN_PCT_OWNER';
      } else if (r.secFilingUrl?.startsWith('https://www.sec.gov/Archives/')) {
        try {
          const res = await secFetch(r.secFilingUrl.replace(/\/xsl[^/]+\//i, '/'), { accept: 'application/xml, text/xml', allowedHosts: ['www.sec.gov'] });
          if (res.ok) kind = detect10b51(await res.text(), 'S') ? 'PLAN_10B5_1' : 'DISCRETIONARY';
        } catch (err) {
          console.warn(`Exit-radar: Form 4 for salg i ${ticker} kunne ikke hentes:`, (err as Error).message);
        }
      }
      sales.push({ name: r.insiderName, title: r.insiderTitle, date: r.tradeDate!, valueUsd: Math.round(r.totalValueUsd), kind });
    }

    const alarms = sales.filter((s) => s.kind === 'DISCRETIONARY' || s.kind === 'UNKNOWN');
    const first = alarms[alarms.length - 1]; // OpenInsider sorterer nyeste først → sidste er det første salg
    if (sales.length === 0) {
      return { status: 'NO_SALES', hasExit: false, checkedAt, sales, message: `0 insider-salg (kode S) siden ${openDate}` };
    }
    return {
      status: 'SALES_FOUND',
      hasExit: alarms.length > 0,
      checkedAt,
      sales,
      ...(first
        ? {
            firstAlertAt: checkedAt,
            firstAlert: first,
            sellerName: first.name,
            sellerTitle: first.title,
            saleDate: first.date,
            saleValueUsd: first.valueUsd,
          }
        : {}),
      message: sales
        .map((s) => `${s.name} (${s.title}) solgte for $${s.valueUsd.toLocaleString('en-US')} den ${s.date} – ${SALE_KIND_LABEL[s.kind]}`)
        .join(' • '),
    };
  } catch (err) {
    return { status: 'ERROR', hasExit: false, checkedAt, message: `Exit-radar fejlede: ${(err as Error).message}` };
  }
}
