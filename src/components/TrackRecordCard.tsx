import type { InsiderTransaction, TrackRecordReputation } from '@/types/insider';
import { stripEmoji } from '@/lib/ui-labels';
import { Card, Chip, Label, type Tone } from '@/components/ui';

// Kort mærke i overskriften; den fulde reputationLabel (med tal) står under.
const REPUTATION: Record<TrackRecordReputation, { text: string; tone: Tone }> = {
  SMART_MONEY_SNIPER: { text: 'Smart money', tone: 'gain' },
  CREDIBLE_BUYER: { text: 'Kredibel køber', tone: 'accent' },
  FIRST_TIME_OR_RARE: { text: 'Sjældent signal', tone: 'accent' },
  EARLY_OR_BAGHOLDER: { text: 'Bagholder-risiko', tone: 'loss' },
  UNKNOWN: { text: 'mangler data', tone: 'unknown' },
};

const LABEL_BORDER: Record<Tone, string> = {
  gain: 'border-gain',
  loss: 'border-loss',
  accent: 'border-accent',
  neutral: 'border-line',
  unknown: 'border-dashed border-graphite/70 text-graphite',
};

const pct = (n: number) => `${n.toLocaleString('da-DK')} %`;
const signedPct = (n: number) => `${n > 0 ? '+' : ''}${pct(n)}`;
const compactUsd = (v: number) => (v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : `$${Math.round(v / 1000)}k`);

/** Insiderens og selskabets historik med tidligere køb (track-record.ts). Kun visning af tx.trackRecord. */
export function TrackRecordCard({ tx }: { tx: Pick<InsiderTransaction, 'insiderName' | 'trackRecord'> }) {
  const tr = tx.trackRecord;
  if (!tr) return null;
  const rep = REPUTATION[tr.reputation] ?? { text: tr.reputation, tone: 'neutral' as Tone };
  const unknown = tr.reputation === 'UNKNOWN';

  return (
    <section aria-labelledby="track-record-title" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="track-record-title" className="text-base font-semibold">
          Insiderens historik og træfsikkerhed
        </h3>
        <Chip tone={rep.tone}>{rep.text}</Chip>
      </div>
      <p className={`border-l-2 pl-3 text-sm leading-relaxed ${LABEL_BORDER[rep.tone]}`}>{stripEmoji(tr.reputationLabel)}</p>

      {/* Skjules ved UNKNOWN, så 0-tal ikke ligner målte tal */}
      {!unknown && (
        <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-line bg-line">
          <Stat label="Målte køb" sub="handler · afkast efter 6 mdr.">
            {tr.historicalBuysCount}
          </Stat>
          <Stat label="Historisk win rate" tone={tr.winRatePct >= 65 ? 'text-gain' : tr.winRatePct <= 30 ? 'text-loss' : 'text-ink'}>
            {pct(tr.winRatePct)}
          </Stat>
          <Stat label="Gns. afkast" tone={tr.avgReturnPct > 0 ? 'text-gain' : tr.avgReturnPct < 0 ? 'text-loss' : 'text-ink'}>
            {signedPct(tr.avgReturnPct)}
          </Stat>
        </dl>
      )}

      {/* Selskabets historik ovenfor; insiderens egen historik og ikke-målte køb her */}
      {tr.horizonTradingDays !== undefined && (
        <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <dt className="text-graphite">Insideren selv</dt>
          <dd>
            {tx.insiderName}
            <span className="text-graphite">
              {' · '}
              {tr.insiderOnly && tr.insiderOnly.historicalBuysCount > 0 ? (
                <>
                  <span className="font-mono">{tr.insiderOnly.historicalBuysCount}</span> målte køb, <span className="font-mono">{pct(tr.insiderOnly.winRatePct)}</span> win
                  rate, gns. <span className="font-mono">{signedPct(tr.insiderOnly.avgReturnPct)}</span>
                </>
              ) : (
                'ingen målte køb'
              )}
            </span>
          </dd>
          <dt className="text-graphite">Ikke målt</dt>
          <dd>
            <span className="font-mono">{tr.unmeasuredBuysCount ?? 0}</span> <span className="text-graphite">køb yngre end 6 mdr.</span>
          </dd>
          <dt className="text-graphite">Udbud/IPO</dt>
          <dd>
            {tr.excludedOfferingBuys === undefined ? (
              <span className="text-graphite">ikke tjekket</span>
            ) : (
              <>
                <span className="font-mono">{tr.excludedOfferingBuys}</span> <span className="text-graphite">køb i udbud/IPO udeladt</span>
              </>
            )}
          </dd>
        </dl>
      )}

      {tr.notablePastTrades.length > 0 ? (
        <div className="space-y-1.5">
          <Label>Udvalgte historiske køb i aktien</Label>
          <Card>
            <ul className="divide-y divide-line">
              {tr.notablePastTrades.map((trade, idx) => (
                <li key={idx} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 p-3">
                  <div className="min-w-0">
                    <div className="text-sm">
                      {trade.insiderName}
                      {trade.insiderTitle ? <span className="text-graphite"> ({trade.insiderTitle})</span> : null}
                    </div>
                    <div className="font-mono text-xs text-graphite">{trade.date}</div>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs text-graphite">
                      Købt á <span className="font-mono">${trade.price}</span> (<span className="font-mono">{compactUsd(trade.valueUsd)}</span>)
                    </span>
                    <Chip tone={trade.returnPct > 0 ? 'gain' : 'loss'}>
                      <span className="font-mono">{signedPct(trade.returnPct)}</span>
                    </Chip>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ) : (
        <p className="text-sm text-graphite">
          {unknown
            ? 'Track record ukendt – opslaget fejlede, eller tickeren er ikke amerikansk. Det er ikke et signal.'
            : 'Ingen tidligere registrerede åbne markedskøb i selskabet de seneste 3-4 år. Dette indikerer et sjældent regimeskift eller ny overbevisning fra ledelsen.'}
        </p>
      )}
    </section>
  );
}

function Stat({ label, sub, tone = 'text-ink', children }: { label: string; sub?: string; tone?: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface p-3">
      <dt className="text-xs text-graphite">{label}</dt>
      <dd className={`mt-0.5 font-mono text-lg ${tone}`}>{children}</dd>
      {sub && <dd className="mt-0.5 text-xs text-graphite">{sub}</dd>}
    </div>
  );
}
