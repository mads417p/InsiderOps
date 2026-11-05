import type { LucideIcon } from 'lucide-react';
import type { CouncilVerdict } from '@/types/insider';
import { scoreLabel, verdictLabel } from '@/lib/ui-labels';

/** Fælles byggeklodser for "register"-udtrykket: 1 px kant, lille radius, ingen glød. */

export type Tone = 'gain' | 'loss' | 'accent' | 'neutral' | 'unknown';

// Kun kant og tekst – en tonet baggrund ville bringe grøn tekst under WCAG AA i lys tilstand.
const CHIP_TONE: Record<Tone, string> = {
  gain: 'border-gain/50 text-gain',
  loss: 'border-loss/50 text-loss',
  accent: 'border-accent/50 text-accent',
  neutral: 'border-line text-graphite',
  unknown: 'border-dashed border-graphite/70 text-graphite',
};

export function Chip({
  tone = 'neutral',
  icon: Icon,
  title,
  className = '',
  children,
}: {
  tone?: Tone;
  icon?: LucideIcon;
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 py-px text-xs leading-5 ${CHIP_TONE[tone]} ${className}`}
    >
      {Icon && <Icon className="size-3 shrink-0" aria-hidden />}
      {children}
    </span>
  );
}

/** Rådets/gatekeeperens score som dæmpet mærke. Ingen score → "mangler data". Teksten bærer altid betydningen. */
export function StatusChip({ score, prefix }: { score?: number | null; prefix?: string }) {
  if (score === undefined || score === null) return <Chip tone="unknown">mangler data</Chip>;
  const tone: Tone = score >= 75 ? 'gain' : score >= 60 ? 'accent' : 'neutral';
  return (
    <Chip tone={tone}>
      {prefix}
      {scoreLabel(score)} <span className="font-mono">{score}</span>
    </Chip>
  );
}

/** Rådets afgørelse som mærke: label og tone følger dommens tekst (som før), scoren står ved siden af. */
export function VerdictChip({ verdict }: { verdict: Pick<CouncilVerdict, 'verdict' | 'asymmetryScore'> }) {
  const tone: Tone =
    verdict.verdict === 'STRONG ASYMMETRY (KØB)' ? 'gain' : verdict.verdict === 'MODERATE SIGNAL (OVERVÅG)' ? 'accent' : 'neutral';
  return (
    <Chip tone={tone}>
      {verdictLabel(verdict.verdict)} <span className="font-mono">{verdict.asymmetryScore}</span>
    </Chip>
  );
}

export function Card({ className = '', children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`rounded-md border border-line bg-surface ${className}`} {...rest}>
      {children}
    </div>
  );
}

/** Lille overskrift i et kort: sætningsstart, grafit. */
export function Label({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`text-xs text-graphite ${className}`}>{children}</div>;
}

export const btn = {
  primary:
    'inline-flex items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed',
  secondary:
    'inline-flex items-center justify-center gap-1.5 rounded-md border border-graphite/70 bg-surface px-3 py-1.5 text-sm text-ink hover:border-accent hover:text-accent disabled:opacity-40 disabled:cursor-not-allowed',
  quiet:
    'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-graphite hover:bg-line/40 hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed',
  seg: (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-sm ${
      active ? 'bg-surface text-ink font-medium shadow-sm ring-1 ring-line' : 'text-graphite hover:text-ink'
    }`,
};

export const input =
  'rounded-md border border-graphite/70 bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-graphite focus:border-accent';
