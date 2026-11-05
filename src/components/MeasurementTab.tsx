'use client';

import { useEffect, useState } from 'react';
import { Calculator, Loader2 } from 'lucide-react';
import type { Benchmark, LedgerStats, Summary } from '@/lib/ledger-stats';
import { btn, Card, Chip, Label } from '@/components/ui';

type StatsResponse = LedgerStats & {
  success: boolean;
  error?: string;
  costsTodo: string | null;
  costsError: string | null;
  costsSha256: string | null;
  costsMatchPrereg: boolean;
  lastOutcomeAt: string | null;
};
type JobResponse = {
  success: boolean;
  error?: string;
  inserted: number;
  notReached: number;
  missingData: Array<{ signalId: string; horizon: number; reason: string }>;
  fetchErrors: Array<{ symbol: string; error: string }>;
};

const pct = (x: number | null | undefined, digits = 2) =>
  x === null || x === undefined ? '–' : `${(x * 100).toFixed(digits).replace('.', ',')} %`;

const tone = (x: number | null | undefined) => (x === null || x === undefined ? 'text-graphite' : x > 0 ? 'text-gain' : 'text-loss');

const td = 'px-3 py-1.5';
const tdNum = `${td} text-right font-mono whitespace-nowrap`;

function SummaryCells({ s, minN }: { s: Summary; minN: number }) {
  return (
    <>
      <td className={tdNum}>{s.n}</td>
      <td className={`${tdNum} ${tone(s.mean)}`}>{pct(s.mean)}</td>
      <td className={`${tdNum} text-graphite`}>{s.ciLow === null ? '–' : `${pct(s.ciLow)} … ${pct(s.ciHigh)}`}</td>
      <td className={tdNum}>{pct(s.hitRate, 0)}</td>
      <td className={td}>{s.n < minN ? <Chip tone="unknown">for få</Chip> : ''}</td>
    </>
  );
}

/** Kalibreringsplot: hit rate (netto 5-dages abnormalt afkast > 0) pr. 10-point-spand. Punktstørrelse ~ N. */
function CalibrationPlot({ rows }: { rows: Array<{ bucket: string; n: number; hitRate: number | null }> }) {
  const W = 420;
  const H = 180;
  const pad = 36;
  const x = (bucket: string) => pad + ((parseInt(bucket) + 5) / 100) * (W - 2 * pad);
  const y = (r: number) => H - pad - r * (H - 2 * pad);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[420px]" role="img" aria-label="Kalibreringsplot: hit rate pr. score-spand">
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} className="stroke-graphite/60" />
      <line x1={pad} y1={pad} x2={pad} y2={H - pad} className="stroke-graphite/60" />
      <line x1={pad} y1={y(0.5)} x2={W - pad} y2={y(0.5)} className="stroke-line" strokeDasharray="4 4" />
      {[0, 50, 100].map((v) => (
        <text key={v} x={pad + (v / 100) * (W - 2 * pad)} y={H - 10} className="fill-graphite font-mono text-xs" textAnchor="middle">
          {v}
        </text>
      ))}
      {[0, 0.5, 1].map((v) => (
        <text key={v} x={pad - 6} y={y(v) + 4} className="fill-graphite font-mono text-xs" textAnchor="end">
          {v * 100} %
        </text>
      ))}
      {rows
        .filter((r) => r.hitRate !== null)
        .map((r) => (
          <circle key={r.bucket} cx={x(r.bucket)} cy={y(r.hitRate!)} r={3 + Math.min(8, Math.sqrt(r.n))} className="fill-accent/60 stroke-accent">
            <title>{`${r.bucket}: hit rate ${pct(r.hitRate, 0)} (N=${r.n})`}</title>
          </circle>
        ))}
    </svg>
  );
}

/** Rolig besked med kant; første ord siger, hvad slags besked det er (farven bærer ikke betydningen alene). */
function Notice({ lead, children }: { lead: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-loss/50 bg-surface p-3 text-sm leading-relaxed">
      <span className="font-medium text-loss">{lead}</span> {children}
    </div>
  );
}

async function fetchStats(): Promise<StatsResponse> {
  const res = await fetch('/api/ledger', { cache: 'no-store' });
  const data: StatsResponse = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || `HTTP-fejl ${res.status}`);
  return data;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Fanen "Måling": signal-ledgeren målt efter docs/prereg.md. */
export function MeasurementTab() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [horizon, setHorizon] = useState(5);
  const [benchmark, setBenchmark] = useState<Benchmark>('SPY');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchStats()
      .then((d) => {
        if (!alive) return;
        setStats(d);
        setError(null);
      })
      .catch((e) => alive && setError(message(e)));
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const runJob = async () => {
    setRunning(true);
    try {
      const res = await fetch('/api/ledger', { method: 'POST' });
      const data: JobResponse = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP-fejl ${res.status}`);
      setJob(data);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(message(e));
    } finally {
      setRunning(false);
    }
  };

  if (error && !stats) {
    return <Notice lead="Fejl:">Måling kunne ikke hentes: {error}</Notice>;
  }
  if (!stats)
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-graphite">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Henter måling …
      </p>
    );

  const p = stats.prereg;
  const buckets = stats.byBucket[benchmark][String(horizon)] ?? [];
  const calib = stats.byBucket.SPY[String(p.primaryHorizon)] ?? [];
  const gl = stats.goLive;
  const tooSmall = gl.units < p.goLiveMinUnits;

  return (
    <div className="@container space-y-6">
      {/* Hoved og handling */}
      <header className="space-y-3">
        <div>
          <h1 className="font-cond text-xl font-semibold">Måling</h1>
          <p className="text-sm text-graphite">Signal-ledgeren målt efter den præregistrerede plan (prereg {p.version}).</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <button type="button" onClick={runJob} disabled={running} className={btn.secondary}>
            {running ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Calculator className="size-4" aria-hidden />}
            {running ? 'Beregner udfald …' : 'Beregn udfald'}
          </button>
          <span className="text-xs text-graphite">
            Udfald senest beregnet{' '}
            <span className="font-mono">
              {stats.lastOutcomeAt
                ? new Date(stats.lastOutcomeAt).toLocaleString('da-DK', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
                : '–'}
            </span>
          </span>
          {job && (
            <span className="text-xs text-graphite" role="status">
              <span className="font-mono text-ink">{job.inserted}</span> nye udfald · <span className="font-mono text-ink">{job.notReached}</span> horisonter
              ikke nået · <span className="font-mono text-ink">{job.missingData.length}</span> mangler kursdata
              {job.fetchErrors.length > 0 && (
                <>
                  {' '}
                  · hentefejl: <span className="font-mono">{job.fetchErrors.map((f) => f.symbol).join(', ')}</span>
                </>
              )}
            </span>
          )}
        </div>
      </header>

      {(stats.costsTodo || (!stats.costsError && !stats.costsMatchPrereg) || stats.costsError || error) && (
        <div className="space-y-2">
          {stats.costsTodo && <Notice lead="Bemærk:">Omkostningerne i config/costs.json er pladsholdere: {stats.costsTodo}</Notice>}
          {!stats.costsError && !stats.costsMatchPrereg && (
            <Notice lead="Advarsel:">
              config/costs.json afviger fra den frosne version i prereg {p.version} (version {p.costsVersion}, sha256{' '}
              <span className="font-mono">{p.costsSha256.slice(0, 12)}…</span>; nu <span className="font-mono">{stats.costsSha256?.slice(0, 12)}…</span>).
              Ændrede omkostninger kræver en ny prereg-version.
            </Notice>
          )}
          {stats.costsError && <Notice lead="Fejl:">{stats.costsError}</Notice>}
          {error && <Notice lead="Fejl:">{error}</Notice>}
        </div>
      )}

      {/* Nøgletal */}
      <dl className="grid grid-cols-2 gap-3 @2xl:grid-cols-5">
        {[
          ['Signaler i ledgeren', stats.totals.signals],
          ['Claude-scorede', stats.totals.scoredClaude],
          [`I populationen (≤ ${p.freshHours} t)`, `${stats.totals.eligible} (${stats.totals.eligibleAboveThreshold} ≥ ${p.scoreThreshold})`],
          [`Enheder med ${p.primaryHorizon} d-udfald`, stats.totals.unitsWithOutcome[p.primaryHorizon] ?? 0],
          ['Mangler udfald', stats.totals.missingOutcomes],
        ].map(([label, value]) => (
          <Card key={label} className="p-3">
            <dt className="text-xs text-graphite">{label}</dt>
            <dd className="mt-1 font-mono text-xl text-ink">{value}</dd>
          </Card>
        ))}
      </dl>

      {/* Go-live-port */}
      <Card className="space-y-1.5 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">
            Go-live-port{' '}
            <span className="text-sm font-normal text-graphite">
              (prereg {p.version}, {gl.phase === 'interim' ? 'interim-vurdering' : 'endelig vurdering'}, ensidet{' '}
              <span className="font-mono">{Math.round(gl.confidence * 100)} %</span>)
            </span>
          </h2>
          <Chip tone={gl.met ? 'gain' : 'loss'}>{gl.met ? 'Opfyldt' : 'Ikke opfyldt'}</Chip>
        </div>
        <p className="text-sm">
          Enheder med fuldt {p.goLiveHorizon}-dages udfald:{' '}
          <span className="font-mono">
            {gl.units} / {gl.required}
          </span>{' '}
          · gns. {p.primaryHorizon} d netto mod {p.primaryBenchmark}: <span className="font-mono">{pct(gl.mean)}</span> · nedre grænse:{' '}
          <span className="font-mono">{pct(gl.lowerBound)}</span>
        </p>
        <p className="text-sm text-graphite">
          Sekundært (indgår ikke i porten): brutto før omkostninger <span className="font-mono">{pct(stats.gross[String(p.primaryHorizon)]?.mean)}</span> ·
          sanity-tjek, top-tredjedel efter score over bund (punktestimat): {gl.sanityTopAboveBottom === null ? '–' : gl.sanityTopAboveBottom ? 'ja' : 'nej'}. Ved
          go-live handles basisstrategien; scoren må først udvælge handler, når H2 er dokumenteret.
        </p>
        <p className="text-xs text-graphite">
          Månedlige vurderinger før <span className="font-mono">{gl.finalFrom.slice(0, 10)}</span> bruger ensidet{' '}
          <span className="font-mono">{Math.round(p.interimConfidence * 100)} %</span>; den endelige bruger{' '}
          <span className="font-mono">{Math.round(p.finalConfidence * 100)} %</span>.
        </p>
        {tooSmall && (
          <p className="text-sm">
            <span className="font-medium">For få data til konklusioner:</span> tallene nedenfor er beskrivende, til der er{' '}
            <span className="font-mono">{p.goLiveMinUnits}</span> enheder med fuldt {p.goLiveHorizon}-dages udfald.
          </p>
        )}
      </Card>

      {/* Afkast pr. score-spand */}
      <section aria-labelledby="buckets-title" className="space-y-3">
        <h2 id="buckets-title" className="text-base font-semibold">
          Netto abnormalt afkast (DKK, efter omkostninger) pr. score-spand
        </h2>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-graphite">Mod</span>
            <div role="radiogroup" aria-label="Benchmark" className="inline-flex rounded-md bg-line/50 p-0.5">
              {(['SPY', 'IWM'] as const).map((b) => (
                <button key={b} type="button" role="radio" aria-checked={benchmark === b} onClick={() => setBenchmark(b)} className={btn.seg(benchmark === b)}>
                  {b === p.secondaryBenchmark ? `${b} (sekundær)` : b}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-graphite">Horisont</span>
            <div role="radiogroup" aria-label="Horisont" className="inline-flex rounded-md bg-line/50 p-0.5">
              {[1, 5, 21, 63].map((h) => (
                <button key={h} type="button" role="radio" aria-checked={horizon === h} onClick={() => setHorizon(h)} className={btn.seg(horizon === h)}>
                  <span className="font-mono">{h}</span> d
                </button>
              ))}
            </div>
          </div>
        </div>
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-graphite">
              <tr>
                <th className="px-3 py-2 text-left font-normal">Score</th>
                <th className="px-3 py-2 text-right font-normal">N</th>
                <th className="px-3 py-2 text-right font-normal">Gns.</th>
                <th className="px-3 py-2 text-right font-normal">95 %-CI (uge-bootstrap)</th>
                <th className="px-3 py-2 text-right font-normal">Hit rate</th>
                <th className="px-3 py-2">
                  <span className="sr-only">Datagrundlag</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {buckets.length === 0 && (
                <tr className="border-t border-line">
                  <td colSpan={6} className="px-3 py-3 text-graphite">
                    Ingen udfald for {horizon} handelsdage endnu. Tryk Beregn udfald, når horisonten er nået.
                  </td>
                </tr>
              )}
              {buckets.map((b) => (
                <tr key={b.bucket} className="border-t border-line">
                  <td className={`${td} font-mono`}>{b.bucket}</td>
                  <SummaryCells s={b} minN={p.minUnitsForConclusion} />
                </tr>
              ))}
              {horizon === p.primaryHorizon && (
                <tr className="border-t border-graphite/60">
                  <td className={`${td} font-medium`}>Alle ({benchmark === p.primaryBenchmark ? 'primær H1' : 'sekundær'})</td>
                  <SummaryCells s={stats.primary[benchmark]} minN={p.minUnitsForConclusion} />
                </tr>
              )}
              {horizon === p.primaryHorizon && benchmark === p.primaryBenchmark && (
                <tr className="border-t border-line">
                  <td className={td}>≥ {p.scoreThreshold} (sekundær)</td>
                  <SummaryCells s={stats.aboveThreshold} minN={p.minUnitsForConclusion} />
                </tr>
              )}
              {benchmark === p.primaryBenchmark && stats.gross[String(horizon)] && (
                <tr className="border-t border-line">
                  <td className={td}>Alle, brutto før omkostninger (sekundær)</td>
                  <SummaryCells s={stats.gross[String(horizon)]} minN={p.minUnitsForConclusion} />
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </section>

      <div className="grid gap-6 @2xl:grid-cols-2">
        <section aria-labelledby="calib-title" className="space-y-2">
          <h2 id="calib-title" className="text-base font-semibold">
            Kalibrering <span className="text-sm font-normal text-graphite">({p.primaryHorizon} d, hit rate pr. spand)</span>
          </h2>
          {calib.length === 0 ? (
            <p className="text-sm text-graphite">Ingen udfald endnu. Tryk Beregn udfald, når de første horisonter er nået.</p>
          ) : (
            <Card className="p-3">
              <CalibrationPlot rows={calib} />
              <Label className="mt-1">Score-spand (vandret) mod hit rate (lodret). Punktets størrelse følger antallet af enheder.</Label>
            </Card>
          )}
        </section>
        <section aria-labelledby="weeks-title" className="space-y-2">
          <h2 id="weeks-title" className="text-base font-semibold">
            Signaler pr. uge <span className="text-sm font-normal text-graphite">(detektion)</span>
          </h2>
          {stats.perWeek.length === 0 ? (
            <p className="text-sm text-graphite">Ingen signaler i ledgeren endnu – de logges ved hver scan.</p>
          ) : (
            <Card className="space-y-1 p-3">
              {stats.perWeek.map((w) => (
                <div key={w.week} className="flex items-center gap-2 text-sm">
                  <span className="w-20 shrink-0 font-mono text-xs text-graphite">{w.week}</span>
                  <span className="h-2 rounded-sm bg-accent/60" style={{ width: `${Math.min(100, w.count * 2)}%` }} />
                  <span className="font-mono text-xs text-ink">{w.count}</span>
                </div>
              ))}
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}
