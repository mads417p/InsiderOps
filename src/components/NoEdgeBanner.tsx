import { Info } from 'lucide-react';

/** Fast ærligheds-linje (fase 9). Tallene står i research/reports – den kan ikke lukkes. Rolig information, ikke en advarsel. */
export function NoEdgeBanner({ compact = false }: { compact?: boolean }) {
  return (
    <div role="note" className={`flex items-start gap-2 text-graphite ${compact ? 'text-xs' : 'border-b border-line pb-3 text-sm'}`}>
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="leading-relaxed">
        <span className="font-medium text-ink">Ingen dokumenteret edge:</span> backtest (USA 2006–2026, Sverige 2016–2026) gav
        negativt nettoafkast efter omkostninger på 5 dage. Copy trading forventes at give omtrent markedsafkast minus
        omkostninger.{' '}
        <span className="text-xs">Kilde: research/reports/backtest-v1.md og research/reports/backtest-se-v1.md</span>
      </p>
    </div>
  );
}
