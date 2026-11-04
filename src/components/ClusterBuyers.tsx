import type { InsiderTransaction } from '@/types/insider';

const fmtUsd = (v: number) => (v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : `$${Math.round(v / 1000)}k`);

/** Købere i et cluster: D/I pr. køber, personlige mod fonds-købere, og mulig deltagelse i udbud. */
export function ClusterBuyers({ tx }: { tx: Pick<InsiderTransaction, 'isClusterBuy' | 'clusterBuyers' | 'personalBuyers' | 'fundBuyers'> }) {
  const buyers = tx.clusterBuyers ?? [];
  if (!tx.isClusterBuy || buyers.length < 2) return null;
  const unknown = buyers.length - (tx.personalBuyers ?? 0) - (tx.fundBuyers ?? 0);
  return (
    <div className="p-4 rounded bg-slate-900/90 border border-slate-800 space-y-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-800/80 pb-2">
        <span className="text-xs font-mono font-bold text-slate-200">KØBERE I CLUSTERET ({buyers.length})</span>
        <span className="text-[11px] font-mono text-slate-300">
          personlige købere: {tx.personalBuyers ?? 0}, via fonde: {tx.fundBuyers ?? 0}
          {unknown > 0 && <span className="text-slate-500">, D/I ukendt: {unknown}</span>}
        </span>
      </div>
      <ul className="space-y-1.5 text-xs font-mono">
        {buyers.map((b, i) => (
          <li key={`${b.name}-${i}`} className="flex flex-wrap items-center gap-1.5">
            <span className="text-slate-100">{b.name}</span>
            <span className="text-slate-500">({b.title})</span>
            <span
              className={`px-1.5 rounded border text-[10px] ${
                b.ownership === undefined
                  ? 'border-slate-700 text-slate-500'
                  : b.ownership === 'D'
                  ? 'border-cyan-800 text-cyan-300'
                  : 'border-purple-800 text-purple-300'
              }`}
              title={b.via ?? (b.ownership === 'D' ? 'Direkte personligt ejerskab' : b.ownership ? undefined : 'Ejerskab ikke oplyst')}
            >
              {b.ownership ?? 'D/I ukendt'}
              {b.via ? ` · ${b.via.replace(/^by\s+/i, 'via ')}` : ''}
            </span>
            <span className="text-slate-300">
              {fmtUsd(b.valueUsd)}
              {b.price !== undefined ? ` á ${b.currency && b.currency !== 'USD' ? `${b.currency} ` : '$'}${b.price}` : ''}
              {b.tradeDate ? ` · ${b.tradeDate}` : ''}
            </span>
            {b.offeringNote && (
              <span className="px-1.5 rounded border border-amber-700 bg-amber-950/60 text-amber-200 text-[10px]" title={b.offeringNote}>
                mulig deltagelse i udbud
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
