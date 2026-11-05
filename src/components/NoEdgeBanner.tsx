import { AlertTriangle } from 'lucide-react';

/** Fast ærligheds-banner (fase 9). Tallene står i research/reports – banneret kan ikke lukkes. */
export function NoEdgeBanner() {
  return (
    <div role="note" className="flex gap-3 items-start rounded-lg border border-amber-600/60 bg-amber-950/40 px-4 py-3 text-xs text-amber-100">
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" aria-hidden />
      <p className="leading-relaxed">
        <strong className="text-amber-300">Ingen dokumenteret edge:</strong> backtest (USA 2006–2026, Sverige 2016–2026) gav
        negativt nettoafkast efter omkostninger på 5 dage. Copy trading forventes at give omtrent markedsafkast minus
        omkostninger.{' '}
        <span className="text-amber-300/80 font-mono">
          Kilde: research/reports/backtest-v1.md og research/reports/backtest-se-v1.md
        </span>
      </p>
    </div>
  );
}
