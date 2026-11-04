import type { OutcomeRow, SignalRow } from '@/lib/ledger';
import { anchorFor } from '@/lib/outcomes';
import { roundTripCostPct, type CostsConfig } from '@/lib/costs';

/**
 * Måling (fase 3, 6) efter docs/prereg.md. Reglerne står her ét sted, så fanen og præregistreringen
 * altid er ens. Ændres en værdi, efter data er set, kræver det en ny prereg-version med ny dato.
 */
export const PREREG = {
  version: 'v1',
  scoreThreshold: 50, // primær population: gatekeeper-score ≥ 50 (Claude)
  primaryHorizon: 5,
  freshHours: 72, // detectedAt − filedAt (UTC) ≤ 72 t
  goLiveHorizon: 21,
  goLiveMinUnits: 60,
  minUnitsForConclusion: 30, // under dette vises "for få til konklusioner" pr. spand
  bootstrapResamples: 10_000,
  bootstrapSeed: 20261104,
} as const;

const HORIZONS = [1, 5, 21, 63] as const;

/** Analyseenhed: (ticker, entry-dag). Signaler på samme aktie samme dag har samme kursforløb → én enhed. */
export interface Unit {
  key: string;
  ticker: string;
  entryDate: string;
  week: string; // ISO-uge for entry-dagen (klynge i bootstrap)
  score: number; // maks Claude-score blandt enhedens signaler
  net: Partial<Record<number, number>>; // abnormalt afkast i DKK minus round-trip-omkostning, pr. horisont
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
    const unit = units.get(key) ?? { key, ticker: s.ticker, entryDate, week: isoWeek(entryDate), score: -1, net: {} };
    unit.score = Math.max(unit.score, s.gatekeeperScore!);
    for (const o of outs) unit.net[o.horizon] ??= o.abnormalDkk - costPct / 100;
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
  lowerOneSided95: number | null; // 5 %
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
  return { ...base, ciLow: q(0.025), ciHigh: q(0.975), lowerOneSided95: q(0.05) };
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

export function ledgerStats(input: { signals: SignalRow[]; outcomes: OutcomeRow[]; costs: CostsConfig | null; now: Date; resamples?: number }) {
  const { signals, outcomes, costs, now } = input;
  const resamples = input.resamples ?? PREREG.bootstrapResamples;
  const units = buildUnits(signals, outcomes, costs);
  const has = new Set(outcomes.map((o) => `${o.signalId}|${o.horizon}`));

  // Mangler udfald: horisonten burde være nået (skøn: hverdage siden anker > h + 2), men der er ingen række.
  const missingOutcomes = signals.filter((s) =>
    HORIZONS.some((h) => weekdaysSince(anchorFor(s), now) > h + 2 && !has.has(`${s.id}|${h}`))
  ).length;

  const perWeek = new Map<string, number>();
  for (const s of signals) perWeek.set(isoWeek(s.detectedAt), (perWeek.get(isoWeek(s.detectedAt)) ?? 0) + 1);

  const point = (u: Unit, h: number) => ({ week: u.week, value: u.net[h]! });
  const withH = (h: number) => units.filter((u) => u.net[h] !== undefined);

  const byBucket = Object.fromEntries(
    HORIZONS.map((h) => {
      const groups = new Map<string, Unit[]>();
      for (const u of withH(h)) groups.set(bucketOf(u.score), [...(groups.get(bucketOf(u.score)) ?? []), u]);
      return [
        h,
        [...groups.entries()]
          .sort(([a], [b]) => parseInt(a) - parseInt(b))
          // ponytail: 2.000 resamples pr. spand holder fanen hurtig; go-live-tallene bruger prereg-antallet.
          .map(([bucket, us]) => ({ bucket, ...summarize(us.map((u) => point(u, h)), Math.min(resamples, 2_000)) })),
      ];
    })
  );

  const above = (h: number) => withH(h).filter((u) => u.score >= PREREG.scoreThreshold);
  const primary = summarize(above(PREREG.primaryHorizon).map((u) => point(u, PREREG.primaryHorizon)), resamples);

  // Go-live: stikprøven er enheder over tærsklen med fuldt 21-dages udfald; primær metrik (5 d netto) på dem.
  const goLiveSample = above(PREREG.goLiveHorizon).filter((u) => u.net[PREREG.primaryHorizon] !== undefined);
  const goLivePrimary = summarize(goLiveSample.map((u) => point(u, PREREG.primaryHorizon)), resamples);
  // Top mod bund: øverste og nederste tredjedel efter score blandt alle enheder med fuldt 21-dages udfald.
  const ranked = withH(PREREG.goLiveHorizon)
    .filter((u) => u.net[PREREG.primaryHorizon] !== undefined)
    .sort((a, b) => a.score - b.score);
  const third = Math.floor(ranked.length / 3);
  const bottom = third > 0 ? summarize(ranked.slice(0, third).map((u) => point(u, PREREG.primaryHorizon)), resamples) : null;
  const top = third > 0 ? summarize(ranked.slice(-third).map((u) => point(u, PREREG.primaryHorizon)), resamples) : null;
  const enough = goLiveSample.length >= PREREG.goLiveMinUnits;

  return {
    prereg: PREREG,
    totals: {
      signals: signals.length,
      scoredClaude: signals.filter((s) => s.scoreSource === 'claude').length,
      eligible: signals.filter(isEligible).length,
      units: units.length,
      unitsWithOutcome: Object.fromEntries(HORIZONS.map((h) => [h, withH(h).length])),
      missingOutcomes,
    },
    perWeek: [...perWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, count]) => ({ week, count })),
    byBucket,
    primary,
    topVsBottom: { top, bottom },
    goLive: {
      units: goLiveSample.length,
      required: PREREG.goLiveMinUnits,
      lowerOneSided95: goLivePrimary.lowerOneSided95,
      topBeatsBottom: top && bottom && top.mean !== null && bottom.mean !== null ? top.mean > bottom.mean : null,
      met:
        enough &&
        goLivePrimary.lowerOneSided95 !== null &&
        goLivePrimary.lowerOneSided95 > 0 &&
        top !== null &&
        bottom !== null &&
        (top.mean ?? -Infinity) > (bottom.mean ?? Infinity),
    },
  };
}

export type LedgerStats = ReturnType<typeof ledgerStats>;
