import { ChevronDown } from 'lucide-react';
import type { CouncilVerdict } from '@/types/insider';
import { stripEmoji } from '@/lib/ui-labels';
import { btn, Card, Chip } from '@/components/ui';

/** stripEmoji pr. linje: stripEmoji samler al whitespace (også linjeskift), og her skal linjerne bevares. */
const stripEmojiLines = (s: string) => s.split('\n').map(stripEmoji).join('\n');

const SPECIALISTS: Array<{ key: keyof CouncilVerdict['reports']; name: string; focus: string }> = [
  { key: 'profiler', name: 'Insider-profiløren', focus: 'Magtposition og skin-in-the-game' },
  { key: 'catalyst', name: 'Katalysator-jægeren', focus: 'Informationsasymmetri og timing' },
  { key: 'skeptic', name: 'Den kritiske skeptiker', focus: 'Djævelens advokat og value traps' },
];

/**
 * Rådets baggrund: dommerens tankestrøm (kun API'ets resumé), de tre specialisters rapporter og
 * markedskonteksten, dommen bygger på. Kun visning – fold ud/ind styres af page.tsx's state.
 */
export function CouncilDetails({
  verdict,
  contextNotes,
  showThinking,
  onToggleThinking,
  showContextNotes,
  onToggleContextNotes,
}: {
  verdict: CouncilVerdict;
  /** selectedTx.contextNotes – kurs og nyheder, rådet fik med. */
  contextNotes?: string;
  showThinking: boolean;
  onToggleThinking: () => void;
  showContextNotes: boolean;
  onToggleContextNotes: () => void;
}) {
  return (
    <>
      {verdict.judgeThinking && (
        <Fold
          id="council-thinking"
          title="Dommerens ræsonnement"
          meta={
            <>
              Resumé fra API · <Chip className="font-mono">{verdict.modelsUsed?.judge || 'ukendt model'}</Chip>
            </>
          }
          open={showThinking}
          onToggle={onToggleThinking}
          toggleLabel={showThinking ? 'Skjul tankestrøm' : 'Vis tankestrøm'}
        >
          <div tabIndex={0} className="max-h-80 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-ink">{stripEmojiLines(verdict.judgeThinking)}</div>
        </Fold>
      )}

      <section aria-labelledby="council-reports-title" className="space-y-2">
        <h3 id="council-reports-title" className="text-base font-semibold">
          Specialisternes rapporter
        </h3>
        <Card className="divide-y divide-line">
          {SPECIALISTS.map((s) => (
            <article key={s.key} aria-labelledby={`council-report-${s.key}`} className="p-4">
              <h4 id={`council-report-${s.key}`} className="text-sm font-semibold">
                {s.name} <span className="font-normal text-graphite">· {s.focus}</span>
              </h4>
              <p className="mt-1.5 text-sm leading-relaxed">{stripEmoji(verdict.reports[s.key])}</p>
            </article>
          ))}
        </Card>
      </section>

      {contextNotes && (
        <Fold
          id="council-context"
          title="Markedskontekst og nyheder"
          meta="Grundlag for rådets dom"
          open={showContextNotes}
          onToggle={onToggleContextNotes}
          toggleLabel={showContextNotes ? 'Skjul detaljer' : 'Vis kurs og nyheder'}
        >
          <div className="whitespace-pre-line text-sm leading-relaxed">{stripEmojiLines(contextNotes)}</div>
        </Fold>
      )}
    </>
  );
}

/** Rolig fold-ud-sektion: overskrift og knap i én række, indhold under en tynd linje. */
function Fold({
  id,
  title,
  meta,
  open,
  onToggle,
  toggleLabel,
  children,
}: {
  id: string;
  title: string;
  meta: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  toggleLabel: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`}>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 p-4">
          <div className="min-w-0">
            <h3 id={`${id}-title`} className="text-base font-semibold">
              {title}
            </h3>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-graphite">{meta}</div>
          </div>
          <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={id} className={btn.quiet}>
            {toggleLabel}
            <ChevronDown className={`size-4 ${open ? 'rotate-180' : ''}`} aria-hidden />
          </button>
        </div>
        <div id={id} hidden={!open} className="border-t border-line p-4">
          {children}
        </div>
      </Card>
    </section>
  );
}
