import type { InsiderTransaction } from '@/types/insider';
import { Card, Chip } from '@/components/ui';

const fmtUsd = (v: number) => (v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : `$${Math.round(v / 1000)}k`);

/** Købere i et cluster: D/I pr. køber, personlige mod fonds-købere, og mulig deltagelse i udbud. */
export function ClusterBuyers({ tx }: { tx: Pick<InsiderTransaction, 'isClusterBuy' | 'clusterBuyers' | 'personalBuyers' | 'fundBuyers'> }) {
  const buyers = tx.clusterBuyers ?? [];
  if (!tx.isClusterBuy || buyers.length < 2) return null;
  const unknown = buyers.length - (tx.personalBuyers ?? 0) - (tx.fundBuyers ?? 0);
  return (
    <Card className="space-y-2 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold">
          Købere i clusteret <span className="font-mono text-sm font-normal text-graphite">{buyers.length}</span>
        </h3>
        <span className="text-xs text-graphite">
          Personlige købere: <span className="font-mono text-ink">{tx.personalBuyers ?? 0}</span>, via fonde:{' '}
          <span className="font-mono text-ink">{tx.fundBuyers ?? 0}</span>
          {unknown > 0 && (
            <>
              , D/I ukendt: <span className="font-mono text-ink">{unknown}</span>
            </>
          )}
        </span>
      </div>
      <ul className="divide-y divide-line text-sm">
        {buyers.map((b, i) => (
          <li key={`${b.name}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
            <span>{b.name}</span>
            <span className="text-graphite">{b.title}</span>
            <Chip
              tone={b.ownership === undefined ? 'unknown' : b.ownership === 'D' ? 'accent' : 'neutral'}
              title={b.via ?? (b.ownership === 'D' ? 'Direkte personligt ejerskab' : b.ownership ? undefined : 'Ejerskab ikke oplyst')}
              className="max-w-full"
            >
              <span className="truncate">
                {b.ownership ?? 'D/I ukendt'}
                {b.via ? ` · ${b.via.replace(/^by\s+/i, 'via ')}` : ''}
              </span>
            </Chip>
            <span className="font-mono text-graphite">
              <span className="text-ink">{fmtUsd(b.valueUsd)}</span>
              {b.price !== undefined ? ` á ${b.currency && b.currency !== 'USD' ? `${b.currency} ` : '$'}${b.price}` : ''}
              {b.tradeDate ? ` · ${b.tradeDate}` : ''}
            </span>
            {b.offeringNote && (
              <Chip tone="loss" title={b.offeringNote}>
                Mulig deltagelse i udbud
              </Chip>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
