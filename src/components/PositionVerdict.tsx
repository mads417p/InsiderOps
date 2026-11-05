import type { CouncilVerdict } from '@/types/insider';
import { stripEmoji, verdictLabel } from '@/lib/ui-labels';
import { Chip } from '@/components/ui';

/** Nyeste validerede dom for positionens ticker, og om den afviger fra scoren ved åbning. */
export function PositionVerdict({
  openedScore,
  latest,
}: {
  openedScore: number;
  latest: { verdict: CouncilVerdict; at: string | undefined } | null;
}) {
  if (!latest) {
    return <Chip tone="unknown">Ingen valideret dom</Chip>;
  }
  const { verdict, at } = latest;
  const action = verdictLabel(verdict.verdict);
  const date = at && !isNaN(Date.parse(at)) ? new Date(at).toLocaleDateString('da-DK') : 'ukendt dato';
  const changed = verdict.asymmetryScore !== openedScore;
  return (
    <>
      <Chip title={stripEmoji(verdict.headline)}>
        Nyeste dom: <span className="font-mono">{verdict.asymmetryScore}</span> · {action} · <span className="font-mono">{date}</span>
      </Chip>
      {changed && (
        <Chip tone={verdict.asymmetryScore < openedScore ? 'loss' : 'gain'}>
          Dom ændret:{' '}
          <span className="font-mono">
            {openedScore} → {verdict.asymmetryScore}
          </span>
        </Chip>
      )}
    </>
  );
}
