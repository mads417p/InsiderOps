import type { RealKpis } from '@/types/insider';

const kr = (n: number) => `${n > 0 ? '+' : ''}${n.toLocaleString('da-DK')} kr.`;
const tone = (n: number | null) => (n === null ? 'text-slate-400' : n >= 0 ? 'text-emerald-400' : 'text-rose-400');

/** Egne KPI'er for rigtige Nordnet-handler (fase 9): virker mine copy trades? */
export function RealKpiRow({ kpis }: { kpis: RealKpis | null }) {
  const count = kpis ? kpis.openCount + kpis.closedCount : 0;
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-mono font-bold text-slate-400 uppercase">🏦 Mine Nordnet-handler</div>
      {!kpis || count === 0 ? (
        <div className="p-4 rounded-lg bg-slate-900/70 border border-slate-800 text-xs font-mono text-slate-400">
          Ingen rigtige handler endnu. Registrér en handel som &quot;Nordnet Live&quot; under Redigér, og ret kurs og antal
          til dem fra Nordnet.
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card title="AFKAST (DKK, NETTO)" sub={`Brutto ${kr(kpis.grossPnlDkk)} · investeret ${kpis.investedDkk.toLocaleString('da-DK')} kr.`}>
            <span className={tone(kpis.netPnlDkk)}>{kr(kpis.netPnlDkk)}</span>
            {kpis.netPnlPct !== null && (
              <span className={`text-sm ml-2 ${tone(kpis.netPnlPct)}`}>
                ({kpis.netPnlPct > 0 ? '+' : ''}
                {kpis.netPnlPct.toLocaleString('da-DK')} %)
              </span>
            )}
          </Card>
          <Card
            title="ALPHA MOD SPY"
            sub={kpis.alphaPct === null ? 'Mangler data (SPY ved entry)' : `Vægtet over ${kpis.alphaCount} handler, åbne + lukkede`}
          >
            <span className={tone(kpis.alphaPct)}>
              {kpis.alphaPct === null ? 'N/A' : `${kpis.alphaPct > 0 ? '+' : ''}${kpis.alphaPct.toLocaleString('da-DK')} %-point`}
            </span>
          </Card>
          <Card title="ANTAL HANDLER" sub={`${kpis.openCount} åbne · ${kpis.closedCount} lukkede`}>
            <span className="text-slate-100">{count}</span>
          </Card>
          <Card
            title="SAMLEDE OMKOSTNINGER"
            sub={
              kpis.costsMissing > 0
                ? `${kpis.costsMissing} handel(er) uden tarif – ikke medregnet`
                : 'Kurtage + veksling (Nordnet-tarif). Spread ligger i dine kurser.'
            }
          >
            <span className="text-amber-300">{kpis.costsDkk.toLocaleString('da-DK')} kr.</span>
          </Card>
        </div>
      )}
    </div>
  );
}

function Card({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-900/70 border border-slate-800 p-4 rounded-lg space-y-1">
      <div className="text-slate-400 text-xs font-mono">{title}</div>
      <div className="text-2xl font-mono font-bold">{children}</div>
      <div className="text-[11px] text-slate-400 font-mono">{sub}</div>
    </div>
  );
}
