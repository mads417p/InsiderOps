import type { RealKpis } from '@/types/insider';
import { Card, Label } from '@/components/ui';

const kr = (n: number) => `${n > 0 ? '+' : ''}${n.toLocaleString('da-DK')} kr.`;
const tone = (n: number | null) => (n === null ? 'text-graphite' : n >= 0 ? 'text-gain' : 'text-loss');

/** Egne KPI'er for rigtige Nordnet-handler (fase 9): virker mine copy trades? */
export function RealKpiRow({ kpis }: { kpis: RealKpis | null }) {
  const count = kpis ? kpis.openCount + kpis.closedCount : 0;
  return (
    <section aria-labelledby="real-kpi-title" className="@container space-y-3">
      <h2 id="real-kpi-title" className="text-base font-semibold">
        Mine Nordnet-handler
      </h2>
      {!kpis || count === 0 ? (
        <Card className="p-4 text-sm text-graphite">
          Ingen rigtige handler endnu. Registrér en handel som &quot;Nordnet Live&quot; under Redigér, og ret kurs og antal til dem fra Nordnet.
        </Card>
      ) : (
        <dl className="grid gap-3 @md:grid-cols-2 @4xl:grid-cols-4">
          <Kpi
            title="Afkast (DKK, netto)"
            sub={
              <>
                Brutto <span className="font-mono">{kr(kpis.grossPnlDkk)}</span> · investeret{' '}
                <span className="font-mono">{kpis.investedDkk.toLocaleString('da-DK')} kr.</span>
              </>
            }
          >
            <span className={tone(kpis.netPnlDkk)}>{kr(kpis.netPnlDkk)}</span>
            {kpis.netPnlPct !== null && (
              <span className={`ml-2 text-sm ${tone(kpis.netPnlPct)}`}>
                ({kpis.netPnlPct > 0 ? '+' : ''}
                {kpis.netPnlPct.toLocaleString('da-DK')} %)
              </span>
            )}
          </Kpi>
          <Kpi
            title="Alpha mod SPY"
            sub={
              kpis.alphaPct === null ? (
                'Mangler data (SPY ved entry)'
              ) : (
                <>
                  Vægtet over <span className="font-mono">{kpis.alphaCount}</span> handler, åbne + lukkede
                </>
              )
            }
          >
            <span className={tone(kpis.alphaPct)}>
              {kpis.alphaPct === null ? '–' : `${kpis.alphaPct > 0 ? '+' : ''}${kpis.alphaPct.toLocaleString('da-DK')} %-point`}
            </span>
          </Kpi>
          <Kpi
            title="Antal handler"
            sub={
              <>
                <span className="font-mono">{kpis.openCount}</span> åbne · <span className="font-mono">{kpis.closedCount}</span> lukkede
              </>
            }
          >
            <span className="text-ink">{count}</span>
          </Kpi>
          <Kpi
            title="Samlede omkostninger"
            sub={
              kpis.costsMissing > 0 ? (
                <>
                  <span className="font-mono">{kpis.costsMissing}</span> handel(er) uden tarif – ikke medregnet
                </>
              ) : (
                'Kurtage + veksling (Nordnet-tarif). Spread ligger i dine kurser.'
              )
            }
          >
            <span className="text-ink">{kpis.costsDkk.toLocaleString('da-DK')} kr.</span>
          </Kpi>
        </dl>
      )}
    </section>
  );
}

function Kpi({ title, sub, children }: { title: string; sub: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card className="space-y-1 p-4">
      <dt>
        <Label>{title}</Label>
      </dt>
      <dd className="font-mono text-xl">{children}</dd>
      <dd className="text-xs text-graphite">{sub}</dd>
    </Card>
  );
}
