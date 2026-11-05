import type { RejectedRow } from '@/types/insider';
import { stripEmoji } from '@/lib/ui-labels';
import { Card } from '@/components/ui';

/** Liste over rækker, scan-pipelinen afviste, med årsag pr. række. */
export function RejectedNoisePanel({ rows }: { rows: RejectedRow[] }) {
  if (rows.length === 0) {
    return <Card className="p-4 text-sm text-graphite">Ingen afviste rækker i denne scan.</Card>;
  }
  return (
    <Card className="max-h-80 overflow-y-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Afviste rækker og årsagen til afvisningen</caption>
        <thead className="sticky top-0 bg-surface text-xs text-graphite">
          <tr>
            <th className="px-3 py-2 text-left font-normal">Ticker</th>
            <th className="px-3 py-2 text-left font-normal">Insider</th>
            <th className="px-3 py-2 text-left font-normal">Årsag</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-line align-top">
              <td className="whitespace-nowrap px-3 py-1.5 font-cond font-semibold">{r.ticker}</td>
              <td className="px-3 py-1.5">{r.insiderName}</td>
              <td className="px-3 py-1.5 text-graphite">{stripEmoji(r.reason)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
