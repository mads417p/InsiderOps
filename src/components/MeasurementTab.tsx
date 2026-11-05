'use client';

import { useEffect, useState } from 'react';
import type { Benchmark, LedgerStats, Summary } from '@/lib/ledger-stats';

type StatsResponse = LedgerStats & {
  success: boolean;
  error?: string;
  costsTodo: string | null;
  costsError: string | null;
  costsSha256: string | null;
  costsMatchPrereg: boolean;
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

const tone = (x: number | null | undefined) => (x === null || x === undefined ? 'text-slate-500' : x > 0 ? 'text-emerald-300' : 'text-rose-300');

function SummaryCells({ s, minN }: { s: Summary; minN: number }) {
  return (
    <>
      <td className="py-1.5 px-3 text-right">{s.n}</td>
      <td className={`py-1.5 px-3 text-right ${tone(s.mean)}`}>{pct(s.mean)}</td>
      <td className="py-1.5 px-3 text-right text-slate-400">
        {s.ciLow === null ? '–' : `${pct(s.ciLow)} … ${pct(s.ciHigh)}`}
      </td>
      <td className="py-1.5 px-3 text-right">{pct(s.hitRate, 0)}</td>
      <td className="py-1.5 px-3 text-amber-400/80">{s.n < minN ? 'for få' : ''}</td>
    </>
  );
}

/** Kalibreringsplot: hit rate (netto 5-dages abnormalt afkast > 0) pr. 10-point-spand. Punktstørrelse ~ N. */
function CalibrationPlot({ rows }: { rows: Array<{ bucket: string; n: number; hitRate: number | null }> }) {
  const W = 420;
  const H = 180;
  const pad = 28;
  const x = (bucket: string) => pad + ((parseInt(bucket) + 5) / 100) * (W - 2 * pad);
  const y = (r: number) => H - pad - r * (H - 2 * pad);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-xl" role="img" aria-label="Kalibreringsplot: hit rate pr. score-spand">
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} className="stroke-slate-700" />
      <line x1={pad} y1={pad} x2={pad} y2={H - pad} className="stroke-slate-700" />
      <line x1={pad} y1={y(0.5)} x2={W - pad} y2={y(0.5)} className="stroke-slate-800" strokeDasharray="4 4" />
      {[0, 50, 100].map((v) => (
        <text key={v} x={pad + (v / 100) * (W - 2 * pad)} y={H - 8} className="fill-slate-500 text-[9px]" textAnchor="middle">
          {v}
        </text>
      ))}
      {[0, 0.5, 1].map((v) => (
        <text key={v} x={pad - 4} y={y(v) + 3} className="fill-slate-500 text-[9px]" textAnchor="end">
          {v * 100}%
        </text>
      ))}
      {rows
        .filter((r) => r.hitRate !== null)
        .map((r) => (
          <circle key={r.bucket} cx={x(r.bucket)} cy={y(r.hitRate!)} r={3 + Math.min(8, Math.sqrt(r.n))} className="fill-cyan-400/60 stroke-cyan-300">
            <title>{`${r.bucket}: hit rate ${pct(r.hitRate, 0)} (N=${r.n})`}</title>
          </circle>
        ))}
    </svg>
  );
}

async function fetchStats(): Promise<StatsResponse> {
  const res = await fetch('/api/ledger', { cache: 'no-store' });
  const data: StatsResponse = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || `HTTP-fejl ${res.status}`);
  return data;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Fanen "📏 Måling": signal-ledgeren målt efter docs/prereg.md. */
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
    return <div className="p-3 rounded border border-rose-800 bg-rose-950/40 text-xs font-mono text-rose-300">Måling kunne ikke hentes: {error}</div>;
  }
  if (!stats) return <div className="text-xs font-mono text-slate-400">Henter måling…</div>;

  const p = stats.prereg;
  const buckets = stats.byBucket[benchmark][String(horizon)] ?? [];
  const calib = stats.byBucket.SPY[String(p.primaryHorizon)] ?? [];
  const gl = stats.goLive;
  const tooSmall = gl.units < p.goLiveMinUnits;

  return (
    <div className="space-y-5 font-mono text-xs">
      {stats.costsTodo && (
        <div className="p-3 rounded border border-amber-700 bg-amber-950/40 text-amber-200">
          ⚠️ Omkostningerne i config/costs.json er pladsholdere: {stats.costsTodo}
        </div>
      )}
      {!stats.costsError && !stats.costsMatchPrereg && (
        <div className="p-3 rounded border border-rose-800 bg-rose-950/40 text-rose-300">
          ⚠️ config/costs.json afviger fra den frosne version i prereg {p.version} (version {p.costsVersion}, sha256 {p.costsSha256.slice(0, 12)}…;
          nu {stats.costsSha256?.slice(0, 12)}…). Ændrede omkostninger kræver en ny prereg-version.
        </div>
      )}
      {stats.costsError && <div className="p-3 rounded border border-rose-800 bg-rose-950/40 text-rose-300">{stats.costsError}</div>}
      {error && <div className="p-3 rounded border border-rose-800 bg-rose-950/40 text-rose-300">{error}</div>}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={runJob}
          disabled={running}
          className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 disabled:opacity-50"
        >
          {running ? 'Beregner udfald…' : 'Beregn udfald'}
        </button>
        {job && (
          <span className="text-slate-400">
            {job.inserted} nye udfald · {job.notReached} horisonter ikke nået · {job.missingData.length} mangler kursdata
            {job.fetchErrors.length > 0 && ` · hentefejl: ${job.fetchErrors.map((f) => f.symbol).join(', ')}`}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          ['SIGNALER I LEDGEREN', stats.totals.signals],
          ['CLAUDE-SCOREDE', stats.totals.scoredClaude],
          [`I POPULATIONEN (≤ ${p.freshHours} t)`, `${stats.totals.eligible} (${stats.totals.eligibleAboveThreshold} ≥ ${p.scoreThreshold})`],
          [`ENHEDER MED ${p.primaryHorizon} D-UDFALD`, stats.totals.unitsWithOutcome[p.primaryHorizon] ?? 0],
          ['MANGLER UDFALD', stats.totals.missingOutcomes],
        ].map(([label, value]) => (
          <div key={label} className="bg-slate-900/60 border border-slate-800/80 p-3 rounded">
            <div className="text-slate-400">{label}</div>
            <div className="mt-1 text-xl font-bold text-cyan-300">{value}</div>
          </div>
        ))}
      </div>

      <div className={`p-3 rounded border ${gl.met ? 'border-emerald-700 bg-emerald-950/30' : 'border-slate-800 bg-slate-900/60'}`}>
        <div className="font-bold text-slate-200">
          Go-live-port (prereg {p.version}, {gl.phase === 'interim' ? 'interim-vurdering' : 'endelig vurdering'}, ensidet {Math.round(gl.confidence * 100)} %)
        </div>
        <div className="mt-1 text-slate-300">
          Enheder med fuldt {p.goLiveHorizon}-dages udfald: {gl.units} / {gl.required} · gns. {p.primaryHorizon} d netto mod {p.primaryBenchmark}: {pct(gl.mean)} ·
          nedre grænse: {pct(gl.lowerBound)} →{' '}
          <span className={gl.met ? 'text-emerald-300 font-bold' : 'text-amber-300 font-bold'}>{gl.met ? 'OPFYLDT' : 'IKKE OPFYLDT'}</span>
        </div>
        <div className="mt-1 text-slate-400">
          Sekundært (indgår ikke i porten): brutto før omkostninger {pct(stats.gross[String(p.primaryHorizon)]?.mean)} · sanity-tjek, top-tredjedel efter
          score over bund (punktestimat): {gl.sanityTopAboveBottom === null ? '–' : gl.sanityTopAboveBottom ? 'ja' : 'nej'}. Ved go-live handles
          basisstrategien; scoren må først udvælge handler, når H2 er dokumenteret.
        </div>
        <div className="mt-1 text-slate-500">
          Månedlige vurderinger før {gl.finalFrom.slice(0, 10)} bruger ensidet {Math.round(p.interimConfidence * 100)} %; den endelige bruger {Math.round(p.finalConfidence * 100)} %.
        </div>
        {tooSmall && (
          <div className="mt-1 text-amber-300/90">
            For få data til konklusioner: tallene nedenfor er beskrivende, til der er {p.goLiveMinUnits} enheder med fuldt {p.goLiveHorizon}-dages udfald.
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-slate-300 font-bold">Netto abnormalt afkast (DKK, efter omkostninger) pr. score-spand mod</span>
          {(['SPY', 'IWM'] as const).map((b) => (
            <button
              key={b}
              onClick={() => setBenchmark(b)}
              className={`px-2 py-0.5 rounded border ${benchmark === b ? 'border-cyan-500 text-cyan-300' : 'border-slate-700 text-slate-400'}`}
            >
              {b === p.secondaryBenchmark ? `${b} (sekundær)` : b}
            </button>
          ))}
          {[1, 5, 21, 63].map((h) => (
            <button
              key={h}
              onClick={() => setHorizon(h)}
              className={`px-2 py-0.5 rounded border ${horizon === h ? 'border-cyan-500 text-cyan-300' : 'border-slate-700 text-slate-400'}`}
            >
              {h} d
            </button>
          ))}
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/60 overflow-x-auto">
          <table className="w-full">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-2 px-3 font-normal">Score</th>
                <th className="text-right py-2 px-3 font-normal">N</th>
                <th className="text-right py-2 px-3 font-normal">Gns.</th>
                <th className="text-right py-2 px-3 font-normal">95 %-CI (uge-bootstrap)</th>
                <th className="text-right py-2 px-3 font-normal">Hit rate</th>
                <th className="py-2 px-3" />
              </tr>
            </thead>
            <tbody>
              {buckets.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-3 px-3 text-slate-500">
                    Ingen udfald for {horizon} handelsdage endnu.
                  </td>
                </tr>
              )}
              {buckets.map((b) => (
                <tr key={b.bucket} className="border-t border-slate-800/80">
                  <td className="py-1.5 px-3 text-slate-200">{b.bucket}</td>
                  <SummaryCells s={b} minN={p.minUnitsForConclusion} />
                </tr>
              ))}
              {horizon === p.primaryHorizon && (
                <tr className="border-t border-slate-700">
                  <td className="py-1.5 px-3 text-cyan-300">Alle ({benchmark === p.primaryBenchmark ? 'primær H1' : 'sekundær'})</td>
                  <SummaryCells s={stats.primary[benchmark]} minN={p.minUnitsForConclusion} />
                </tr>
              )}
              {horizon === p.primaryHorizon && benchmark === p.primaryBenchmark && (
                <tr className="border-t border-slate-800/80">
                  <td className="py-1.5 px-3 text-slate-300">≥ {p.scoreThreshold} (sekundær)</td>
                  <SummaryCells s={stats.aboveThreshold} minN={p.minUnitsForConclusion} />
                </tr>
              )}
              {benchmark === p.primaryBenchmark && stats.gross[String(horizon)] && (
                <tr className="border-t border-slate-800/80">
                  <td className="py-1.5 px-3 text-slate-300">Alle, brutto før omkostninger (sekundær)</td>
                  <SummaryCells s={stats.gross[String(horizon)]} minN={p.minUnitsForConclusion} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        <div>
          <div className="text-slate-300 font-bold mb-2">Kalibrering ({p.primaryHorizon} d, hit rate pr. spand)</div>
          {calib.length === 0 ? <div className="text-slate-500">Ingen udfald endnu.</div> : <CalibrationPlot rows={calib} />}
        </div>
        <div>
          <div className="text-slate-300 font-bold mb-2">Signaler pr. uge (detektion)</div>
          {stats.perWeek.length === 0 ? (
            <div className="text-slate-500">Ingen signaler i ledgeren endnu – de logges ved hver scan.</div>
          ) : (
            <div className="space-y-1">
              {stats.perWeek.map((w) => (
                <div key={w.week} className="flex items-center gap-2">
                  <span className="w-20 text-slate-400">{w.week}</span>
                  <span className="h-2 bg-cyan-500/60 rounded" style={{ width: `${Math.min(100, w.count * 2)}%` }} />
                  <span className="text-slate-300">{w.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
