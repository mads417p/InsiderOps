import { Bookmark, CheckCircle2 } from 'lucide-react';
import type { InsiderTransaction, PaperTradePosition, TradeExecutionPlan } from '@/types/insider';
import { BreakEven } from '@/components/BreakEven';
import { btn, Card, Chip, Label } from '@/components/ui';
import { formatDateTimeDk, stripEmoji } from '@/lib/ui-labels';

const kr = (n: number) => `${n.toLocaleString('da-DK')} kr.`;

/** Handelsplanen (ATR-stop, størrelse, omkostning og ordrer). Kun visning af generateTradeExecutionPlan. */
export function TradePlanCard({
  tx,
  plan,
  currSym,
  maxCapitalDkk,
  onCapital,
  useTranches,
  onTranches,
  fxUpdatedAt,
  position,
  portfolioLoading,
  onOpenPaperTrade,
  holdNote,
}: {
  tx: InsiderTransaction;
  plan: TradeExecutionPlan;
  currSym: string;
  maxCapitalDkk: number;
  onCapital: (dkk: number) => void;
  useTranches: boolean;
  onTranches: (on: boolean) => void;
  fxUpdatedAt?: string;
  position?: PaperTradePosition;
  portfolioLoading: boolean;
  onOpenPaperTrade: () => void;
  holdNote: string;
}) {
  const active = plan.status === 'ACTIVE_PLAN';
  return (
    <section aria-labelledby="plan-title" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="plan-title" className="text-base font-semibold">
          Handelsplan og risiko <span className="text-sm font-normal text-graphite">(frie midler)</span>
        </h3>
        <Chip tone={active ? 'neutral' : 'loss'}>{stripEmoji(plan.volatilityTag)}</Chip>
      </div>
      <Label>
        ATR-baseret stop og størrelse, én ordre som standard. Valutakurser opdateret{' '}
        <span className="font-mono">{fxUpdatedAt ? formatDateTimeDk(fxUpdatedAt) : '–'}</span>
      </Label>

      <div className="flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label="Allokeringsramme" className="inline-flex rounded-md bg-line/50 p-0.5">
          {[10000, 25000, 50000, 100000].map((amt) => (
            <button key={amt} type="button" role="radio" aria-checked={maxCapitalDkk === amt} onClick={() => onCapital(amt)} className={btn.seg(maxCapitalDkk === amt)}>
              <span className="font-mono">{amt / 1000}k</span>
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-sm text-graphite">
          <input type="checkbox" checked={useTranches} onChange={(e) => onTranches(e.target.checked)} className="accent-[var(--accent)]" />
          Del i to trancher (fordobler købskurtagen)
        </label>
      </div>

      {!active ? (
        <Card className="p-4">
          <p className="text-sm font-medium">Ingen ordre anbefales – kapitalbeskyttelse</p>
          <p className="mt-1 text-sm text-graphite">{plan.reason}</p>
        </Card>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line">
            <Metric label="Position" value={kr(plan.recommendedAllocationDkk)}>
              {plan.totalShares} aktier{currSym === '$' && ` ($${plan.recommendedAllocationUsd.toLocaleString('da-DK')})`}
              {plan.tranche2.shares > 0 ? ` · T1 ${plan.tranche1.shares} / T2 ${plan.tranche2.shares}` : ' · én ordre'}
            </Metric>
            <Metric label="Indgangszone" value={`${currSym}${plan.entryZoneMin} – ${currSym}${plan.entryZoneMax}`}>
              Insiderkøb {currSym}
              {tx.pricePerShare || '–'} · {stripEmoji(plan.entryZoneLabel)}
            </Metric>
            <Metric label="Stop-loss (ATR, hård)" value={`${currSym}${plan.stopLossPrice}`} tone="text-loss">
              {plan.stopLossRiskPct.toLocaleString('da-DK')} % fra kurs · maks. tab {kr(plan.maxLossDkk)}
            </Metric>
            <Metric label="Kursmål (90 dages modstand)" value={`${currSym}${plan.targetPrice1}`}>
              +{plan.targetReturnPct1.toLocaleString('da-DK')} % · risiko/afkast 1 : {plan.riskRewardRatio.toLocaleString('da-DK')} · ATR {currSym}
              {tx.atr14d || '–'}
            </Metric>
          </dl>

          <BreakEven compact cost={plan.cost} basis={plan.cost ? `ved planens ${plan.cost.orders} ordrer (køb og salg)` : ''} />
          {plan.cost?.minFeeWarning && (
            <p className="text-sm text-graphite">
              <span className="text-ink">Bemærk:</span> under ca. <span className="font-mono">{kr(plan.cost.minFeeBelowDkk)}</span> pr. ordre slår
              minimumskurtagen igennem, så kurtagen bliver relativt dyrere.
            </p>
          )}

          <Card className="divide-y divide-line">
            <Order title={plan.tranche2.shares > 0 ? 'Tranche 1 (60 %)' : 'Én ordre'} dkk={plan.tranche1.allocationDkk}>
              <span className="font-mono">{plan.tranche1.shares}</span> aktier á <span className="font-mono">{currSym}{plan.tranche1.price}</span>, limit ved
              markedsåbning
            </Order>
            {plan.tranche2.shares > 0 && (
              <Order title="Tranche 2 (40 %), limit ved tilbagefald" dkk={plan.tranche2.allocationDkk}>
                <span className="font-mono">{plan.tranche2.shares}</span> aktier á <span className="font-mono">{currSym}{plan.tranche2.price}</span>, stående
                limit-ordre
              </Order>
            )}
          </Card>

          <p className="text-xs leading-relaxed text-graphite">
            <span className="text-ink">Holdeperiode:</span> {holdNote}
          </p>

          {position ? (
            <p className="flex items-center gap-1.5 text-sm">
              <CheckCircle2 className="size-4 text-gain" aria-hidden />
              I paper-porteføljen ·{' '}
              <span className={`font-mono ${position.pnlDkk >= 0 ? 'text-gain' : 'text-loss'}`}>
                {position.pnlDkk >= 0 ? '+' : ''}
                {position.pnlDkk.toLocaleString('da-DK')} kr. ({position.pnlPct.toLocaleString('da-DK')} %)
              </span>
            </p>
          ) : (
            <button type="button" onClick={onOpenPaperTrade} disabled={portfolioLoading} className={btn.primary}>
              <Bookmark className="size-4" aria-hidden />
              Åbn paper-trade <span className="font-mono">({kr(plan.recommendedAllocationDkk)})</span>
            </button>
          )}
        </>
      )}
    </section>
  );
}

function Metric({ label, value, tone = 'text-ink', children }: { label: string; value: string; tone?: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface p-3">
      <dt className="text-xs text-graphite">{label}</dt>
      <dd className={`mt-0.5 font-mono text-lg ${tone}`}>{value}</dd>
      <dd className="mt-0.5 text-xs text-graphite">{children}</dd>
    </div>
  );
}

function Order({ title, dkk, children }: { title: string; dkk: number; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 p-3">
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-sm text-graphite">{children}</div>
      </div>
      <div className="whitespace-nowrap font-mono text-sm">{kr(dkk)}</div>
    </div>
  );
}
