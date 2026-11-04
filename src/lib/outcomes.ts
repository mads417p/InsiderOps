import { HORIZONS, insertOutcome, listOutcomes, listSignals, type OutcomeRow, type SignalRow } from '@/lib/ledger';

/**
 * Udfaldsjob (fase 3, 4): beregner manglende udfald for 1/5/21/63 handelsdage, når horisonten er nået.
 * Entry = åbningskurs første handelsdag EFTER ankeret (børsens lokale dato); exit = lukkekurs på handelsdag h
 * (entry-dagen er dag 1). Handelsdage = de dage, der findes kurser for, så weekender og helligdage aldrig
 * kræver en kalender. Manglende kurs giver ingen række (aldrig 0), og et beregnet udfald overskrives ikke.
 */

export const OUTCOME_DATA_SOURCE = 'Yahoo chart v8 interval=1d (open/close, split-justeret, ekskl. udbytte)';
const MAX_FX_STALE_DAYS = 7;

export interface DailyBar {
  date: string; // børsens lokale dato (YYYY-MM-DD)
  open: number | null;
  close: number | null;
}
export interface BarSeries {
  symbol: string;
  timeZone: string;
  bars: DailyBar[]; // stigende dato
}

/** Lokal dato (YYYY-MM-DD) for et tidspunkt i en tidszone. */
export function localDate(instant: string | number | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
}

const price = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null);

/** Yahoo-arrays → serie. Rækker uden både open og close er ikke handelsdage og udelades. */
export function toSeries(symbol: string, timeZone: string, timestamps: number[], opens: unknown[], closes: unknown[]): BarSeries {
  const bars: DailyBar[] = [];
  timestamps.forEach((t, i) => {
    const open = price(opens[i]);
    const close = price(closes[i]);
    if (open === null && close === null) return;
    bars.push({ date: localDate(t * 1000, timeZone), open, close });
  });
  return { symbol, timeZone, bars };
}

export async function fetchDailyBars(symbol: string, fromIso: string, now: Date): Promise<BarSeries> {
  const period1 = Math.floor(Date.parse(fromIso) / 1000) - 7 * 86_400;
  const period2 = Math.floor(now.getTime() / 1000);
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`,
    {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36', Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    }
  );
  if (!res.ok) throw new Error(`Yahoo ${symbol} svarede ${res.status}`);
  const r = (await res.json())?.chart?.result?.[0];
  const tz = r?.meta?.exchangeTimezoneName;
  if (!r || typeof tz !== 'string') throw new Error(`Yahoo ${symbol}: ingen data`);
  const q = r.indicators?.quote?.[0] ?? {};
  return toSeries(symbol, tz, r.timestamp ?? [], q.open ?? [], q.close ?? []);
}

/** Kun færdige bars: dagens bar (lokal dato) kan være en delvis session. */
const finalBars = (s: BarSeries, now: Date) => {
  const today = localDate(now, s.timeZone);
  return s.bars.filter((b) => b.date < today);
};

export function closeOnOrBefore(bars: DailyBar[], date: string): { date: string; close: number } | undefined {
  for (let i = bars.length - 1; i >= 0; i--) {
    const c = bars[i].close;
    if (bars[i].date <= date && c !== null) return { date: bars[i].date, close: c };
  }
  return undefined;
}

const daysBetween = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;

/** FX-close på eller før datoen, højst 7 dage gammel. 1 for DKK. */
function fxOn(fx: BarSeries | null, date: string): number | undefined {
  if (!fx) return 1;
  const c = closeOnOrBefore(fx.bars, date);
  return c && daysBetween(c.date, date) <= MAX_FX_STALE_DAYS ? c.close : undefined;
}

/** Ankeret: signalet blev set (detectedAt), men en score sat senere må ikke se kurser efter entry. */
export const anchorFor = (s: Pick<SignalRow, 'detectedAt' | 'scoredAt'>) =>
  s.scoredAt && s.scoredAt > s.detectedAt ? s.scoredAt : s.detectedAt;

export type OutcomeResult = { status: 'beregnet'; row: OutcomeRow } | { status: 'ikke-nået' } | { status: 'mangler-data'; reason: string };

export function computeOutcome(p: {
  signal: Pick<SignalRow, 'id' | 'currency' | 'detectedAt' | 'scoredAt'>;
  horizon: number;
  stock: BarSeries;
  spy: BarSeries;
  fx: BarSeries | null; // valuta→DKK; null for DKK-aktier
  usdDkk: BarSeries;
  now: Date;
}): OutcomeResult {
  const anchorAt = anchorFor(p.signal);
  const anchorLocal = localDate(anchorAt, p.stock.timeZone);
  const bars = finalBars(p.stock, p.now);
  const entryIdx = bars.findIndex((b) => b.date > anchorLocal);
  if (entryIdx < 0) return { status: 'ikke-nået' };
  const exitIdx = entryIdx + p.horizon - 1;
  if (exitIdx >= bars.length) return { status: 'ikke-nået' };

  const entry = bars[entryIdx];
  const exit = bars[exitIdx];
  if (entry.open === null) return { status: 'mangler-data', reason: `åbningskurs mangler ${entry.date}` };
  if (exit.close === null) return { status: 'mangler-data', reason: `lukkekurs mangler ${exit.date}` };

  // SPY og FX skal også være færdige til og med exit-datoen (NY ligger bag CPH; FX handler døgnet rundt).
  for (const s of [p.spy, p.usdDkk, ...(p.fx ? [p.fx] : [])]) {
    if (localDate(p.now, s.timeZone) <= exit.date) return { status: 'ikke-nået' };
  }

  // SPY i samme kalendervindue: open første SPY-dag ≥ entry, close sidste ≤ exit. Handlede SPY slet ikke
  // i vinduet (fx en nordisk 1-dags-horisont på Thanksgiving), er SPY's kursændring 0.
  const window = p.spy.bars.filter((b) => b.date >= entry.date && b.date <= exit.date);
  let spyEntry: { date: string; price: number } | undefined;
  let spyExit: { date: string; price: number } | undefined;
  if (window.length === 0) {
    const prev = closeOnOrBefore(p.spy.bars, exit.date);
    if (prev) spyEntry = spyExit = { date: prev.date, price: prev.close };
  } else {
    const first = window[0];
    const last = window[window.length - 1];
    if (first.open !== null) spyEntry = { date: first.date, price: first.open };
    if (last.close !== null) spyExit = { date: last.date, price: last.close };
  }
  if (!spyEntry || !spyExit) return { status: 'mangler-data', reason: 'SPY-kurs mangler i vinduet' };

  // Valuta på aktiens entry- og exit-dato for både aktien og SPY (samme kalendervindue).
  const fxEntry = fxOn(p.fx, entry.date);
  const fxExit = fxOn(p.fx, exit.date);
  const usdEntry = fxOn(p.usdDkk, entry.date);
  const usdExit = fxOn(p.usdDkk, exit.date);
  if (fxEntry === undefined || fxExit === undefined || usdEntry === undefined || usdExit === undefined) {
    return { status: 'mangler-data', reason: 'valutakurs mangler' };
  }

  const retLocal = exit.close / entry.open - 1;
  const retDkk = (exit.close * fxExit) / (entry.open * fxEntry) - 1;
  const spyRetUsd = spyExit.price / spyEntry.price - 1;
  const spyRetDkk = ((1 + spyRetUsd) * usdExit) / usdEntry - 1;
  const currency = p.signal.currency.toUpperCase();

  return {
    status: 'beregnet',
    row: {
      signalId: p.signal.id,
      horizon: p.horizon,
      anchorAt,
      currency,
      entryDate: entry.date,
      entryPrice: entry.open,
      exitDate: exit.date,
      exitPrice: exit.close,
      retLocal,
      fxEntry,
      fxExit,
      retDkk,
      spyEntryDate: spyEntry.date,
      spyEntry: spyEntry.price,
      spyExitDate: spyExit.date,
      spyExit: spyExit.price,
      usdDkkEntry: usdEntry,
      usdDkkExit: usdExit,
      spyRetUsd,
      spyRetDkk,
      abnormalDkk: retDkk - spyRetDkk,
      abnormalLocal: currency === 'USD' ? retLocal - spyRetUsd : null,
      dataSource: OUTCOME_DATA_SOURCE,
      computedAt: p.now.toISOString(),
    },
  };
}

const FX_SYMBOL: Record<string, string> = { USD: 'USDDKK=X', EUR: 'EURDKK=X', SEK: 'SEKDKK=X', NOK: 'NOKDKK=X' };

export interface OutcomeJobResult {
  inserted: number;
  notReached: number;
  missingData: Array<{ signalId: string; horizon: number; reason: string }>;
  fetchErrors: Array<{ symbol: string; error: string }>;
}

/** Beregner alle manglende udfald, hvis horisont er nået. write=false = tør kørsel (intet gemmes). */
export async function computeMissingOutcomes(opts: { now?: Date; write?: boolean; fetcher?: typeof fetchDailyBars } = {}): Promise<OutcomeJobResult> {
  const now = opts.now ?? new Date();
  const fetcher = opts.fetcher ?? fetchDailyBars;
  const done = new Set(listOutcomes().map((o) => `${o.signalId}|${o.horizon}`));
  const todo = listSignals()
    .map((s) => ({ s, horizons: HORIZONS.filter((h) => !done.has(`${s.id}|${h}`)) }))
    // ponytail: intet udfald kan være klar samme døgn som ankeret – spar Yahoo-kaldet.
    .filter(({ s, horizons }) => horizons.length > 0 && now.getTime() - Date.parse(anchorFor(s)) > 12 * 3_600_000);

  const result: OutcomeJobResult = { inserted: 0, notReached: 0, missingData: [], fetchErrors: [] };
  if (todo.length === 0) return result;

  // Én hentning pr. symbol, fra det tidligste anker der skal bruge det.
  const earliest = new Map<string, string>();
  const need = (sym: string, from: string) => {
    const cur = earliest.get(sym);
    if (!cur || from < cur) earliest.set(sym, from);
  };
  for (const { s } of todo) {
    const from = anchorFor(s);
    need(s.ticker, from);
    need('SPY', from);
    need('USDDKK=X', from);
    if (FX_SYMBOL[s.currency]) need(FX_SYMBOL[s.currency], from);
  }
  const series = new Map<string, BarSeries>();
  for (const [sym, from] of earliest) {
    try {
      series.set(sym, await fetcher(sym, from, now));
    } catch (e) {
      result.fetchErrors.push({ symbol: sym, error: e instanceof Error ? e.message : String(e) });
    }
  }

  for (const { s, horizons } of todo) {
    const stock = series.get(s.ticker);
    const spy = series.get('SPY');
    const usdDkk = series.get('USDDKK=X');
    const fxSym = FX_SYMBOL[s.currency];
    const fx = s.currency === 'DKK' ? null : fxSym ? series.get(fxSym) : undefined;
    for (const horizon of horizons) {
      if (!stock || !spy || !usdDkk || fx === undefined) {
        result.missingData.push({ signalId: s.id, horizon, reason: 'kursdata kunne ikke hentes' });
        continue;
      }
      const r = computeOutcome({ signal: s, horizon, stock, spy, fx, usdDkk, now });
      if (r.status === 'ikke-nået') result.notReached++;
      else if (r.status === 'mangler-data') result.missingData.push({ signalId: s.id, horizon, reason: r.reason });
      else if (opts.write === false || insertOutcome(r.row)) result.inserted++;
    }
  }
  return result;
}
