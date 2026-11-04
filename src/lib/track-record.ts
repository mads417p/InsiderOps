import { InsiderTransaction, InsiderTrackRecord, NotablePastTrade, TrackRecordReputation } from '@/types/insider';
import { fetchOpenInsiderHtml, getCikForTicker, normalizeName, parseOpenInsiderTable } from '@/lib/sec-scanner';
import { getOfferingsNear, matchOffering, type Offering } from '@/lib/offering-check';

/** Fast måle-horisont: ca. 6 måneder. Køb, der er yngre end horisonten, kan ikke måles og udelades. */
export const HORIZON_TRADING_DAYS = 126;
export const MIN_MEASURED_FOR_SNIPER = 3;
export const RARE_WINDOW_DAYS = 730; // 24 måneder
const CLUSTER_EXCLUSION_DAYS = 14; // handler tæt på det aktuelle køb er en del af samme runde, ikke historik
const DAY_MS = 86_400_000;

export interface PastBuy {
  date: string; // handelsdato YYYY-MM-DD
  insiderName: string;
  insiderTitle?: string;
  ownerCik?: string;
  price: number;
  valueUsd: number;
}

export interface PriceHistory {
  dates: string[]; // YYYY-MM-DD, stigende
  closes: number[]; // split-justerede lukkekurser
}

export interface MeasuredBuy extends PastBuy {
  returnPct: number;
}

/** Sammenligner navne for at tjekke om to strenge refererer til samme insider. */
export function isSamePerson(nameA: string, nameB: string): boolean {
  const a = normalizeName(nameA);
  const b = normalizeName(nameB);
  if (!a || !b) return false;
  if (a === b) return true;
  const pa = a.split(' ');
  const pb = b.split(' ');
  // OpenInsider/SEC skriver "Efternavn Fornavn [Mellemnavn]": samme første og andet ord = samme person
  return pa.length >= 2 && pb.length >= 2 && pa[0] === pb[0] && pa[1] === pb[1];
}

/**
 * Måler hvert køb over en fast horisont: kursen HORIZON_TRADING_DAYS handelsdage efter handelsdagen
 * mod lukkekursen på handelsdagen (begge split-justerede, så aktiesplit ikke giver falske afkast).
 * Køb, der er yngre end horisonten, returneres som ikke målte – de må ikke måles til dagens kurs.
 */
export function measureAtHorizon(
  buys: PastBuy[],
  history: PriceHistory,
  horizon = HORIZON_TRADING_DAYS
): { measured: MeasuredBuy[]; unmeasured: PastBuy[] } {
  const measured: MeasuredBuy[] = [];
  const unmeasured: PastBuy[] = [];
  for (const buy of buys) {
    const idx = history.dates.findIndex((d) => d >= buy.date);
    const target = idx === -1 ? -1 : idx + horizon;
    if (idx === -1 || target >= history.closes.length || !(history.closes[idx] > 0)) {
      unmeasured.push(buy);
      continue;
    }
    const returnPct = Number((((history.closes[target] - history.closes[idx]) / history.closes[idx]) * 100).toFixed(1));
    measured.push({ ...buy, returnPct });
  }
  return { measured, unmeasured };
}

function stats(measured: MeasuredBuy[]) {
  const n = measured.length;
  const wins = measured.filter((t) => t.returnPct > 0).length;
  return {
    historicalBuysCount: n,
    winRatePct: n > 0 ? Math.round((wins / n) * 100) : 0,
    avgReturnPct: n > 0 ? Number((measured.reduce((s, t) => s + t.returnPct, 0) / n).toFixed(1)) : 0,
  };
}

/**
 * Reputation ud fra målte køb:
 * - FIRST_TIME_OR_RARE: siden er læst korrekt, og der er 0 åbne markedskøb de seneste 24 måneder.
 * - UNKNOWN: der er køb, men ingen kan måles endnu (alle yngre end horisonten).
 * - SMART_MONEY_SNIPER: mindst 3 målte køb, win rate ≥ 65 % og gns. ≥ +10 %.
 * - EARLY_OR_BAGHOLDER: gns. ≤ −20 %, eller mindst 2 målte køb med win rate ≤ 20 %.
 */
export function classifyReputation(
  measured: MeasuredBuy[],
  priorBuys: PastBuy[],
  refDate: string
): { reputation: TrackRecordReputation; reputationLabel: string } {
  const refTime = Date.parse(refDate.slice(0, 10));
  const recent = priorBuys.filter((b) => refTime - Date.parse(b.date) <= RARE_WINDOW_DAYS * DAY_MS);
  if (recent.length === 0) {
    return { reputation: 'FIRST_TIME_OR_RARE', reputationLabel: '🆕 Sjældent signal: ingen åbne markedskøb fra ledelsen de seneste 24 mdr.' };
  }
  if (measured.length === 0) {
    return { reputation: 'UNKNOWN', reputationLabel: `❔ For få målte køb: alle ${priorBuys.length} tidligere køb er yngre end 6 mdr.` };
  }
  const { winRatePct, avgReturnPct } = stats(measured);
  const fmt = `${winRatePct}% win rate, gns. ${avgReturnPct > 0 ? '+' : ''}${avgReturnPct}% efter 6 mdr., ${measured.length} målte køb`;
  if (measured.length >= MIN_MEASURED_FOR_SNIPER && winRatePct >= 65 && avgReturnPct >= 10) {
    return { reputation: 'SMART_MONEY_SNIPER', reputationLabel: `🎯 Smart Money Sniper (${fmt})` };
  }
  if (avgReturnPct <= -20 || (measured.length >= 2 && winRatePct <= 20)) {
    return { reputation: 'EARLY_OR_BAGHOLDER', reputationLabel: `⚠️ Tidligere køb i minus (${fmt}) – bagholder-risiko` };
  }
  return { reputation: 'CREDIBLE_BUYER', reputationLabel: `📈 Kredibel køber (${fmt})` };
}

/** Deler tidligere køb i markedskøb og køb, der matcher et registreret udbud (samme kurs, ±7 dage). */
export function excludeOfferingBuys(buys: PastBuy[], offerings: Offering[]): { kept: PastBuy[]; excluded: PastBuy[] } {
  const kept: PastBuy[] = [];
  const excluded: PastBuy[] = [];
  for (const b of buys) (matchOffering({ tradeDate: b.date, price: b.price }, offerings) ? excluded : kept).push(b);
  return { kept, excluded };
}

/** Byg track record ud fra tidligere køb og kurshistorik (ren funktion – testbar uden netværk). */
export function buildTrackRecord(tx: InsiderTransaction, allBuys: PastBuy[], history: PriceHistory): InsiderTrackRecord {
  const refDate = (tx.tradeDate || tx.filedAt || new Date().toISOString()).slice(0, 10);
  const cutoff = Date.parse(refDate) - CLUSTER_EXCLUSION_DAYS * DAY_MS;
  const prior = allBuys.filter((b) => Date.parse(b.date) < cutoff);

  const { measured, unmeasured } = measureAtHorizon(prior, history);
  const { reputation, reputationLabel } = classifyReputation(measured, prior, refDate);

  const same = (b: PastBuy) => (b.ownerCik && tx.ownerCik ? b.ownerCik === tx.ownerCik : isSamePerson(b.insiderName, tx.insiderName));
  const insiderMeasured = measured.filter(same);

  const notablePastTrades: NotablePastTrade[] = [...measured]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5)
    .map((t) => ({ date: t.date, insiderName: t.insiderName, insiderTitle: t.insiderTitle, price: t.price, valueUsd: t.valueUsd, returnPct: t.returnPct }));

  return {
    ...stats(measured),
    reputation,
    reputationLabel,
    notablePastTrades,
    horizonTradingDays: HORIZON_TRADING_DAYS,
    unmeasuredBuysCount: unmeasured.length,
    insiderOnly: { ...stats(insiderMeasured), unmeasuredBuysCount: unmeasured.filter(same).length },
  };
}

/** Daglige lukkekurser 5 år tilbage (Yahoo, split-justeret). Kaster ved fejl. */
async function fetchPriceHistory(ticker: string): Promise<PriceHistory> {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5y&interval=1d`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Yahoo kurshistorik svarede ${res.status}`);
  const r = (await res.json())?.chart?.result?.[0];
  const ts: number[] = r?.timestamp ?? [];
  const closes: Array<number | null> = r?.indicators?.quote?.[0]?.close ?? [];
  const history: PriceHistory = { dates: [], closes: [] };
  ts.forEach((t, i) => {
    const c = closes[i];
    if (typeof c === 'number' && c > 0) {
      history.dates.push(new Date(t * 1000).toISOString().slice(0, 10));
      history.closes.push(c);
    }
  });
  if (history.closes.length < 2) throw new Error('Yahoo kurshistorik er tom');
  return history;
}

/**
 * Henter og beregner den historiske track record for et selskabs insidere: åbne markedskøb (kode P)
 * de seneste 4 år, hvert målt over en fast horisont (126 handelsdage). Selskabets og insiderens egen
 * historik holdes adskilt. Opslags- eller parsefejl giver UNKNOWN – aldrig "første gang".
 */
export async function fetchInsiderTrackRecord(tx: InsiderTransaction): Promise<InsiderTrackRecord> {
  const cleanTicker = tx.ticker.trim().toUpperCase();

  // OpenInsider dækker kun US. Nordiske tickers har ingen track record her → mangler data (ikke "første gang").
  if (/\.(CO|ST|HE|OL)$/.test(cleanTicker)) {
    return unknownRecord('ingen track record-kilde for nordiske aktier');
  }

  try {
    const [html, history] = await Promise.all([
      // 4 år × 500 rækker tager ca. 8 s hos OpenInsider (målt 4.11.2026) – standardloftet på 8 s gav UNKNOWN.
      fetchOpenInsiderHtml(`s=${encodeURIComponent(cleanTicker)}&o=&pl=&ph=&ll=&lh=&fd=1461&fdr=&td=0&tdr=&xp=1&vl=10&vh=&sortcol=0&cnt=500&page=1`, 20_000),
      fetchPriceHistory(cleanTicker),
    ]);
    // Kaster ved ulæselig side (parse-fejl → UNKNOWN). En gyldig side uden tabel = 0 køb.
    const rows = parseOpenInsiderTable(html, 'tr');
    let buys: PastBuy[] = rows
      .filter((r) => r.transactionCode === 'P' && r.tradeDate && r.ticker.toUpperCase() === cleanTicker)
      .map((r) => ({
        date: r.tradeDate!,
        insiderName: r.insiderName,
        insiderTitle: r.insiderTitle,
        ownerCik: r.ownerCik,
        price: r.pricePerShare,
        valueUsd: r.totalValueUsd,
      }));

    // Køb i en IPO eller et udbud (kurs = udbudskurs) er ikke markedskøb (RAPP: IPO-dagen 10.6.2024 til $17,00).
    let excludedOfferingBuys: number | undefined;
    try {
      const cik = tx.issuerCik ?? (await getCikForTicker(cleanTicker))?.cik;
      if (cik) {
        const split = excludeOfferingBuys(buys, await getOfferingsNear(cik, buys.map((b) => b.date)));
        buys = split.kept;
        excludedOfferingBuys = split.excluded.length;
      }
    } catch (err) {
      // Udbud ukendt: købene beholdes (intet gæt), og excludedOfferingBuys forbliver undefined.
      console.warn(`Udbudstjek af track record for ${cleanTicker} fejlede:`, (err as Error).message);
    }
    return { ...buildTrackRecord(tx, buys, history), excludedOfferingBuys };
  } catch (err) {
    console.warn(`Track record for ${cleanTicker} kunne ikke beregnes:`, (err as Error).message);
    return unknownRecord(`opslag eller parsing fejlede (${(err as Error).message})`);
  }
}

/** Opslaget gav ingen data. Tallene er 0, men reputation UNKNOWN betyder, at de ikke må læses som et signal. */
function unknownRecord(reason: string): InsiderTrackRecord {
  return {
    historicalBuysCount: 0,
    winRatePct: 0,
    avgReturnPct: 0,
    reputation: 'UNKNOWN',
    reputationLabel: `❔ Mangler data: ${reason}`,
    notablePastTrades: [],
  };
}
