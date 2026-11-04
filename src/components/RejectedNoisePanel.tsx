import type { RejectedRow } from '@/types/insider';

/** Liste over rækker, scan-pipelinen afviste, med årsag pr. række. */
export function RejectedNoisePanel({ rows }: { rows: RejectedRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="p-3 rounded border border-slate-800 bg-slate-900/60 text-xs font-mono text-slate-400">
        Ingen afviste rækker i denne scan.
      </div>
    );
  }
  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 max-h-80 overflow-y-auto">
      <table className="w-full text-xs font-mono">
        <thead className="sticky top-0 bg-slate-900 text-slate-400">
          <tr>
            <th className="text-left py-2 px-3 font-normal">Ticker</th>
            <th className="text-left py-2 px-3 font-normal">Insider</th>
            <th className="text-left py-2 px-3 font-normal">Årsag</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-slate-800/80 align-top">
              <td className="py-1.5 px-3 text-slate-200 whitespace-nowrap">{r.ticker}</td>
              <td className="py-1.5 px-3 text-slate-300">{r.insiderName}</td>
              <td className="py-1.5 px-3 text-rose-300">{r.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
