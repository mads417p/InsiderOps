'use client';

import { Briefcase, Radar, RefreshCw } from 'lucide-react';
import type { PaperTradePosition, PortfolioSummary, RealKpis, SavedVerdictItem, TradeType } from '@/types/insider';
import { latestValidatedVerdict } from '@/lib/verdicts';
import { formatDateTimeDk } from '@/lib/ui-labels';
import { RealKpiRow } from '@/components/RealKpiRow';
import { PositionCard, type PositionEditForm } from '@/components/PositionCard';
import { btn, Card } from '@/components/ui';

export interface PortfolioTabProps {
  realKpis: RealKpis | null;
  portfolioSummaries: Partial<Record<TradeType, PortfolioSummary>>;
  portfolioRefreshing: boolean;
  portfolioRefreshedAt: string | null;
  onRefreshPortfolioLivePnl: () => void;
  paperPortfolio: Record<string, PaperTradePosition>;
  /** Tom portefølje: "Gå til Radar" (page.tsx: () => setActiveTab('radar')). */
  onGoToRadar: () => void;
  verdictHistory: Record<string, SavedVerdictItem>;
  editingPosId: string | null;
  setEditingPosId: (id: string | null) => void;
  editForm: PositionEditForm;
  setEditForm: React.Dispatch<React.SetStateAction<PositionEditForm>>;
  isSavingEdit: boolean;
  onStartEdit: (pos: PaperTradePosition) => void;
  onSaveEdit: (id: string) => void;
  onClosePaperTrade: (id: string) => void;
}

const kr = (n: number) => `${n.toLocaleString('da-DK')} kr.`;
const signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toLocaleString('da-DK')}`;
const pnlTone = (n: number) => (n >= 0 ? 'text-gain' : 'text-loss');

/** Porteføljen: egne Nordnet-KPI'er, paper-KPI'er og positionerne. Kun visning – handlinger er callbacks fra page.tsx. */
export function PortfolioTab(p: PortfolioTabProps) {
  // Paper-KPI-række (REAL_NORDNET har sin egen række i RealKpiRow) – PAPER og REAL_NORDNET blandes aldrig.
  const s = p.portfolioSummaries.PAPER;
  const totalPnl = s?.totalPnlDkk || 0;
  const totalPnlPct = s?.totalPnlPct || 0;
  const positions = Object.values(p.paperPortfolio);

  return (
    <div className="@container space-y-6">
      {/* Hoved og handlinger */}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-cond text-xl font-semibold">Portefølje</h1>
          <p className="text-sm text-graphite">Paper-trades og rigtige Nordnet-handler med live kurser og exit-radar</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-graphite">
            Senest opdateret <span className="font-mono">{p.portfolioRefreshedAt ? formatDateTimeDk(p.portfolioRefreshedAt) : '–'}</span>
          </span>
          <button
            type="button"
            onClick={p.onRefreshPortfolioLivePnl}
            disabled={p.portfolioRefreshing}
            className={btn.secondary}
            title="Henter live kurser og tjekker exit-radaren for alle positioner"
          >
            <RefreshCw className={`size-4 ${p.portfolioRefreshing ? 'animate-spin' : ''}`} aria-hidden />
            {p.portfolioRefreshing ? 'Henter kurser …' : 'Opdatér kurser'}
          </button>
        </div>
      </header>

      {/* Egne KPI'er for rigtige Nordnet-handler (fase 9) */}
      <RealKpiRow kpis={p.realKpis} />

      {/* Paper-KPI'er */}
      <section aria-labelledby="paper-kpi-title" className="space-y-2">
        <h2 id="paper-kpi-title" className="text-base font-semibold">
          Paper-trades
        </h2>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line @2xl:grid-cols-3 @4xl:grid-cols-5">
          <Metric label="Samlet investeret" value={kr(s?.totalInvestedDkk || 0)}>
            <span className="font-mono">{s?.openCount || 0}</span> aktive positioner
          </Metric>
          <Metric label="Aktuel markedsværdi" value={kr(s?.totalCurrentValueDkk || 0)}>
            Realtidskurser fra CNBC og Yahoo
          </Metric>
          <Metric label="P&L, realiseret + urealiseret" value={`${signed(totalPnl)} kr.`} tone={pnlTone(totalPnl)}>
            <span className={`font-mono ${pnlTone(totalPnlPct)}`}>{signed(totalPnlPct)} %</span> afkast · {totalPnl >= 0 ? 'gevinst' : 'tab'}
          </Metric>
          <Metric
            label="Alpha mod S&P 500"
            value={typeof s?.avgAlphaPct === 'number' ? `${signed(s.avgAlphaPct)} %` : 'N/A'}
            tone={typeof s?.avgAlphaPct === 'number' ? pnlTone(s.avgAlphaPct) : 'text-graphite'}
          >
            SPY i DKK i perioden:{' '}
            <span className="font-mono">{typeof s?.benchmarkReturnPct === 'number' ? `${signed(s.benchmarkReturnPct)} %` : 'N/A'}</span>
          </Metric>
          <Metric
            label="Gevinstrate, lukkede"
            value={typeof s?.winRatePct === 'number' ? `${s.winRatePct.toLocaleString('da-DK')} %` : 'N/A'}
            tone={typeof s?.winRatePct === 'number' ? 'text-ink' : 'text-graphite'}
            className="col-span-2 @4xl:col-span-1"
          >
            <span className="font-mono">{s?.closedCount ?? 0}</span> lukkede · realiseret{' '}
            <span className="font-mono">{kr(s?.realizedPnlDkk ?? 0)}</span>
          </Metric>
        </dl>
      </section>

      {/* Positioner */}
      <section aria-labelledby="positions-title" className="space-y-3">
        <h2 id="positions-title" className="text-base font-semibold">
          Positioner <span className="font-mono text-sm font-normal text-graphite">{positions.length}</span>
        </h2>
        {positions.length === 0 ? (
          <Card className="space-y-3 p-8 text-center">
            <Briefcase className="mx-auto size-6 text-graphite" aria-hidden />
            <h3 className="text-sm font-semibold">Ingen åbne paper-trades endnu</h3>
            <p className="mx-auto max-w-lg text-sm leading-relaxed text-graphite">
              Start med at scanne Form 4-indberetninger i Radar, lad rådet afsige dom over en asymmetrisk case, og klik derefter på Åbn paper-trade i
              handelsplanen for at følge positionen her.
            </p>
            <button type="button" onClick={p.onGoToRadar} className={btn.primary}>
              <Radar className="size-4" aria-hidden />
              Gå til Radar
            </button>
          </Card>
        ) : (
          <div className="space-y-4">
            {positions.map((pos) => (
              <PositionCard
                key={pos.id}
                pos={pos}
                latestVerdict={latestValidatedVerdict(p.verdictHistory, pos.ticker)}
                editingPosId={p.editingPosId}
                setEditingPosId={p.setEditingPosId}
                editForm={p.editForm}
                setEditForm={p.setEditForm}
                isSavingEdit={p.isSavingEdit}
                onStartEdit={p.onStartEdit}
                onSaveEdit={p.onSaveEdit}
                onClosePaperTrade={p.onClosePaperTrade}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  tone = 'text-ink',
  className = '',
  children,
}: {
  label: string;
  value: string;
  tone?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`min-w-0 bg-surface p-3 ${className}`}>
      <dt className="text-xs text-graphite">{label}</dt>
      <dd className={`mt-0.5 font-mono text-lg ${tone}`}>{value}</dd>
      <dd className="mt-0.5 text-xs text-graphite">{children}</dd>
    </div>
  );
}
