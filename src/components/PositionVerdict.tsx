import type { CouncilVerdict } from '@/types/insider';

/** Nyeste validerede dom for positionens ticker, og om den afviger fra scoren ved åbning. */
export function PositionVerdict({
  openedScore,
  latest,
}: {
  openedScore: number;
  latest: { verdict: CouncilVerdict; at: string | undefined } | null;
}) {
  if (!latest) {
    return (
      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-900 border border-slate-700 text-slate-400">
        Ingen valideret dom
      </span>
    );
  }
  const { verdict, at } = latest;
  const action = verdict.verdict.match(/\(([^)]+)\)/)?.[1] ?? verdict.verdict;
  const date = at && !isNaN(Date.parse(at)) ? new Date(at).toLocaleDateString('da-DK') : 'ukendt dato';
  const changed = verdict.asymmetryScore !== openedScore;
  return (
    <>
      <span
        className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-violet-950 border border-violet-800 text-violet-200"
        title={verdict.headline}
      >
        Nyeste dom: {verdict.asymmetryScore} · {action} · {date}
      </span>
      {changed && (
        <span
          className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border ${
            verdict.asymmetryScore < openedScore
              ? 'bg-rose-950 border-rose-800 text-rose-200'
              : 'bg-emerald-950 border-emerald-800 text-emerald-200'
          }`}
        >
          dom ændret: {openedScore} → {verdict.asymmetryScore}
        </span>
      )}
    </>
  );
}
