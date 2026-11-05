import type { OutcomeRow, SignalRow } from '@/lib/ledger';
import { anchorFor } from '@/lib/outcomes';
import { roundTripCostPct, type CostsConfig } from '@/lib/costs';

/**
 * Måling (fase 3, 6) efter docs/prereg.md. Reglerne står her ét sted, så fanen og præregistreringen
 * altid er ens. Ændres en værdi, efter data er set, kræver det en ny prereg-version med ny dato.
 */
export const PREREG = {
  version: 'v1',
  firstSignalAt: '2026-11-04T21:59:32.062Z', // første signal i ledgeren; 6-måneders-fristen regnes herfra
  primaryHorizon: 5,
  primaryBenchmark: 'SPY',
  secondaryBenchmark: 'IWM', // Russell 2000
  scoreThreshold: 50, // sekundært: score ≥ 50 mod hele populationen (H1 har ingen score-tærskel)
  freshHours: 72, // detectedAt − filedAt (UTC) ≤ 72 t
  goLiveHorizon: 21,
  goLiveMinUnits: 150,
  interimConfidence: 0.99, // månedlige vurderinger før fristen: ensidet 99 %
  finalConfidence: 0.95, // endelig vurdering efter fristen: ensidet 95 %
  finalAfterMonths: 6,
  minUnitsForConclusion: 30, // under dette vises "for få til konklusioner" pr. spand
  bootstrapResamples: 10_000,
  bootstrapSeed: 20261104,
  costsVersion: 3, // config/costs.json er frosset: version + sha256 (LF-linjeskift)
  costsSha256: 'fad087e981ecdcf8c9e6dcea4d9037a2362abbc1e2d9c9683d45f380433cc7f0',
} as const;

export type Benchmark = 'SPY' | 'IWM';
const BENCHMARKS: Benchmark[] = ['SPY', 'IWM'];
const HORIZONS = [1, 5, 21, 63] as const;

/** Analyseenhed: (ticker, entry-dag). Signaler på samme aktie samme dag har samme kursforløb → én enhed. */
export interface Unit {
  key: string;
  ticker: string;
  entryDate: string;
  week: string; // ISO-uge for entry-dagen (klynge i bootstrap)
  score: number; // maks Claude-score blandt enhedens signaler
  net: Record<Benchmark, Partial<Record<number, number>>>; // abnormalt afkast i DKK − round-trip-omkostning
  gross: Partial<Record<number, number>>; // abnormalt afkast i DKK mod SPY før omkostninger (sekundær)
}

export function isoWeek(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); // torsdag i samme ISO-uge afgør året
  const week = Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-U${String(week).padStart(2, '0')}`;
}

/** Population efter prereg: Claude-score, frisk (≤ 72 t fra offentliggørelse) og ikke 10b5-1. */
export function isEligible(s: SignalRow): boolean {
  if (s.scoreSource !== 'claude' || s.gatekeeperScore === null) return false;
  if (s.is10b51 === 1) return false;
  if (!s.filedAtUtc) return false;
  const hours = (Date.parse(s.detectedAt) - Date.parse(s.filedAtUtc)) / 3_600_000;
  return hours >= 0 && hours <= PREREG.freshHours;
}

export function buildUnits(signals: SignalRow[], outcomes: OutcomeRow[], costs: CostsConfig | null): Unit[] {
  const bySignal = new Map<string, OutcomeRow[]>();
  for (const o of outcomes) bySignal.set(o.signalId, [...(bySignal.get(o.signalId) ?? []), o]);
  const units = new Map<string, Unit>();
  for (const s of signals) {
    const outs = bySignal.get(s.id);
    if (!outs?.length || !isEligible(s)) continue;
    const adv = (JSON.parse(s.featuresJson) as { avgDailyDollarVolume?: number }).avgDailyDollarVolume;
    const costPct = costs ? roundTripCostPct(costs, { currency: s.currency, avgDailyDollarVolume: adv }) : undefined;
    if (costPct === undefined) continue; // ukendt omkostning → ingen nettotal (intet gæt)
    const entryDate = outs[0].entryDate;
    const key = `${s.ticker}|${entryDate}`;
    const unit = units.get(key) ?? { key, ticker: s.ticker, entryDate, week: isoWeek(entryDate), score: -1, net: { SPY: {}, IWM: {} }, gross: {} };
    unit.score = Math.max(unit.score, s.gatekeeperScore!);
    for (const o of outs) {
      unit.net.SPY[o.horizon] ??= o.abnormalDkk - costPct / 100;
      unit.gross[o.horizon] ??= o.abnormalDkk;
      if (o.abnormalIwmDkk !== null && o.abnormalIwmDkk !== undefined) unit.net.IWM[o.horizon] ??= o.abnormalIwmDkk - costPct / 100;
    }
    units.set(key, unit);
  }
  return [...units.values()];
}

// ---------------------------------------------------------------- statistik

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Summary {
  n: number;
  weeks: number;
  mean: number | null;
  ciLow: number | null; // 2,5 %
  ciHigh: number | null; // 97,5 %
  lowerOneSided95: number | null; // 5 %-percentil
  lowerOneSided99: number | null; // 1 %-percentil
  hitRate: number | null; // andel med netto > 0
}

/**
 * Gennemsnit med uge-klyngede bootstrap-intervaller: hele ISO-uger trækkes med tilbagelægning, fordi signaler
 * i samme uge deler marked og ikke er uafhængige. Fast seed → samme tal ved hver visning.
 */
export function summarize(points: Array<{ week: string; value: number }>, resamples: number = PREREG.bootstrapResamples): Summary {
  const n = points.length;
  const byWeek = new Map<string, number[]>();
  for (const p of points) byWeek.set(p.week, [...(byWeek.get(p.week) ?? []), p.value]);
  const weeks = [...byWeek.values()];
  const base: Summary = {
    n,
    weeks: weeks.length,
    mean: n ? mean(points.map((p) => p.value)) : null,
    ciLow: null,
    ciHigh: null,
    lowerOneSided95: null,
    lowerOneSided99: null,
    hitRate: n ? points.filter((p) => p.value > 0).length / n : null,
  };
  if (weeks.length < 2) return base;
  const rand = mulberry32(PREREG.bootstrapSeed);
  const means: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let sum = 0;
    let cnt = 0;
    for (let w = 0; w < weeks.length; w++) {
      const wk = weeks[Math.floor(rand() * weeks.length)];
      for (const x of wk) sum += x;
      cnt += wk.length;
    }
    means.push(sum / cnt);
  }
  means.sort((a, b) => a - b);
  const q = (p: number) => means[Math.min(means.length - 1, Math.floor(p * means.length))];
  return { ...base, ciLow: q(0.025), ciHigh: q(0.975), lowerOneSided95: q(0.05), lowerOneSided99: q(0.01) };
}

const bucketOf = (score: number) => {
  const lo = Math.min(90, Math.floor(score / 10) * 10);
  return `${lo}–${lo === 90 ? 100 : lo + 9}`;
};

/** Hverdage efter ankerets dato til i dag (skøn for "horisont nået"; helligdage ignoreres). */
function weekdaysSince(fromIso: string, now: Date): number {
  let n = 0;
  const d = new Date(`${fromIso.slice(0, 10)}T12:00:00Z`);
  const end = now.getTime();
  for (d.setUTCDate(d.getUTCDate() + 1); d.getTime() < end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) n++;
  }
  return n;
}

/** Fristen for den endelige vurdering (første signal + 6 måneder). Før den: interim-vurdering med 99 %. */
export function finalAssessmentFrom(): Date {
  const d = new Date(PREREG.firstSignalAt);
  d.setUTCMonth(d.getUTCMonth() + PREREG.finalAfterMonths);
  return d;
}

export function ledgerStats(input: { signals: SignalRow[]; outcomes: OutcomeRow[]; costs: CostsConfig | null; now: Date; resamples?: number }) {
  const { signals, outcomes, costs, now } = input;
  const resamples = input.resamples ?? PREREG.bootstrapResamples;
  const units = buildUnits(signals, outcomes, costs);
  const has = new Set(outcomes.map((o) => `${o.signalId}|${o.horizon}`));
  const H = PREREG.primaryHorizon;

  // Mangler udfald: horisonten burde være nået (skøn: hverdage siden anker > h + 2), men der er ingen række.
  const missingOutcomes = signals.filter((s) =>
    HORIZONS.some((h) => weekdaysSince(anchorFor(s), now) > h + 2 && !has.has(`${s.id}|${h}`))
  ).length;

  const perWeek = new Map<string, number>();
  for (const s of signals) perWeek.set(isoWeek(s.detectedAt), (perWeek.get(isoWeek(s.detectedAt)) ?? 0) + 1);

  const withH = (h: number, b: Benchmark = 'SPY') => units.filter((u) => u.net[b][h] !== undefined);
  const points = (us: Unit[], h: number, b: Benchmark = 'SPY') => us.map((u) => ({ week: u.week, value: u.net[b][h]! }));

  const byBucket = Object.fromEntries(
    BENCHMARKS.map((b) => [
      b,
      Object.fromEntries(
        HORIZONS.map((h) => {
          const groups = new Map<string, Unit[]>();
          for (const u of withH(h, b)) groups.set(bucketOf(u.score), [...(groups.get(bucketOf(u.score)) ?? []), u]);
          return [
            h,
            [...groups.entries()]
              .sort(([x], [y]) => parseInt(x) - parseInt(y))
              // ponytail: 2.000 resamples pr. spand holder fanen hurtig; go-live-tallene bruger prereg-antallet.
              .map(([bucket, us]) => ({ bucket, ...summarize(points(us, h, b), Math.min(resamples, 2_000)) })),
          ];
        })
      ),
    ])
  ) as Record<Benchmark, Record<string, Array<Summary & { bucket: string }>>>;

  // H1: hele populationen (ingen score-tærskel). Sekundært: score ≥ 50 og IWM som benchmark.
  const primary = {
    SPY: summarize(points(withH(H), H), resamples),
    IWM: summarize(points(withH(H, 'IWM'), H, 'IWM'), resamples),
  };
  const aboveThreshold = summarize(points(withH(H).filter((u) => u.score >= PREREG.scoreThreshold), H), resamples);
  // Sekundært: bruttoafkast (abnormalt mod SPY før omkostninger) for hele populationen pr. horisont.
  const gross = Object.fromEntries(
    HORIZONS.map((h) => [
      h,
      summarize(
        units.filter((u) => u.gross[h] !== undefined).map((u) => ({ week: u.week, value: u.gross[h]! })),
        Math.min(resamples, 2_000)
      ),
    ])
  ) as Record<string, Summary>;

  // Go-live: stikprøven er alle enheder med fuldt 21-dages udfald; primær metrik (5 d netto mod SPY) på dem.
  const goLiveSample = withH(PREREG.goLiveHorizon).filter((u) => u.net.SPY[H] !== undefined);
  const goLivePrimary = summarize(points(goLiveSample, H), resamples);
  // Sanity-tjek (punktestimat, sekundært – ikke en del af porten): øverste mod nederste tredjedel efter score.
  const ranked = [...goLiveSample].sort((a, b) => a.score - b.score);
  const third = Math.floor(ranked.length / 3);
  const bottom = third > 0 ? summarize(points(ranked.slice(0, third), H), resamples) : null;
  const top = third > 0 ? summarize(points(ranked.slice(-third), H), resamples) : null;
  const sanityTopAboveBottom = top && bottom && top.mean !== null && bottom.mean !== null ? top.mean > bottom.mean : null;

  const finalFrom = finalAssessmentFrom();
  const phase: 'interim' | 'endelig' = now >= finalFrom ? 'endelig' : 'interim';
  const confidence = phase === 'endelig' ? PREREG.finalConfidence : PREREG.interimConfidence;
  const lowerBound = phase === 'endelig' ? goLivePrimary.lowerOneSided95 : goLivePrimary.lowerOneSided99;

  return {
    prereg: PREREG,
    totals: {
      signals: signals.length,
      scoredClaude: signals.filter((s) => s.scoreSource === 'claude').length,
      eligible: signals.filter(isEligible).length,
      eligibleAboveThreshold: signals.filter((s) => isEligible(s) && (s.gatekeeperScore ?? -1) >= PREREG.scoreThreshold).length,
      units: units.length,
      unitsWithOutcome: Object.fromEntries(HORIZONS.map((h) => [h, withH(h).length])),
      missingOutcomes,
    },
    perWeek: [...perWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, count]) => ({ week, count })),
    byBucket,
    primary,
    aboveThreshold,
    gross,
    topVsBottom: { top, bottom },
    goLive: {
      phase,
      finalFrom: finalFrom.toISOString(),
      confidence,
      units: goLiveSample.length,
      required: PREREG.goLiveMinUnits,
      mean: goLivePrimary.mean,
      lowerBound,
      sanityTopAboveBottom,
      // Porten bedømmer basisstrategien (H1); scoren indgår ikke (sanity-tjekket vises kun).
      met: goLiveSample.length >= PREREG.goLiveMinUnits && lowerBound !== null && lowerBound > 0,
    },
  };
}

export type LedgerStats = ReturnType<typeof ledgerStats>;
