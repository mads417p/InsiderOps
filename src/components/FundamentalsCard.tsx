import { Flame } from 'lucide-react';
import type { CompanyFundamentals, FundamentalHealthBadge } from '@/types/insider';
import { formatCompactUsd } from '@/lib/fundamentals';
import { runwayLabel, stripEmoji, TONE_CLASS } from '@/lib/ui-labels';
import { Chip, type Tone } from '@/components/ui';

const BADGE: Record<FundamentalHealthBadge, { text: string; tone: Tone }> = {
  FORTRESS_BALANCE: { text: 'Fortress cash', tone: 'gain' },
  SHORT_SQUEEZE_SETUP: { text: 'Short squeeze-setup', tone: 'accent' },
  DILUTION_RISK: { text: 'Udvandingsrisiko (< 9 mdr.)', tone: 'loss' },
  SOLID_RUNWAY: { text: 'Solid runway', tone: 'accent' },
  NEUTRAL: { text: 'Neutral balance', tone: 'neutral' },
  UNKNOWN: { text: 'mangler data', tone: 'unknown' },
};

const dk = (n: number, digits: number) => n.toLocaleString('da-DK', { minimumFractionDigits: digits, maximumFractionDigits: digits });

const Missing = ({ text = 'mangler data' }: { text?: string }) => <span className="font-sans text-graphite">{text}</span>;

/** Beløb i kort USD-form; manglende tal vises som tekst, ikke som et mono-tal. */
const usd = (v?: number | null) => (v === undefined || v === null || isNaN(v) ? <Missing /> : formatCompactUsd(v));

/**
 * Balance, likviditet og short-squeeze for selskabet. Kun visning af tx.fundamentals (fundamentals.ts).
 * `fundamentals` er transaktionens egne eller – som før – den gemte doms transaktions.
 */
export function FundamentalsCard({ fundamentals: f }: { fundamentals?: CompanyFundamentals }) {
  if (!f) return null;
  const badge = BADGE[f.fundamentalHealthBadge] ?? { text: f.fundamentalHealthBadge, tone: 'neutral' as Tone };
  const rl = runwayLabel(f);
  const highShort = (f.shortPercentOfFloat ?? 0) >= 10;

  return (
    <section aria-labelledby="fundamentals-title" className="@container space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="fundamentals-title" className="text-base font-semibold">
          Balance, likviditet og short-squeeze
        </h3>
        <Chip tone={badge.tone}>{badge.text}</Chip>
      </div>
      <p className="text-sm leading-relaxed">{stripEmoji(f.fundamentalSummary)}</p>

      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-md border border-line bg-line @sm:grid-cols-2">
        <Pillar title="Kontanter og gæld" aside={<span className="text-xs text-graphite">SEC XBRL</span>}>
          <Row label="Kontanter">{usd(f.cashAndEquivalentsUsd)}</Row>
          <Row label="Gæld">{usd(f.totalDebtUsd)}</Row>
          <Row label="Nettokontanter" strong className={f.netCashUsd === undefined ? TONE_CLASS.unknown : f.netCashUsd >= 0 ? 'text-gain' : 'text-loss'}>
            {f.netCashUsd !== undefined && f.netCashUsd >= 0 ? '+' : ''}
            {usd(f.netCashUsd)}
          </Row>
        </Pillar>

        <Pillar title="Cash flow og runway" note={rl.text}>
          <Row label="Drift" className={f.isCashFlowPositive ? 'text-gain' : undefined}>
            {f.isCashFlowPositive ? (
              <span className="font-sans">Cash-flow positiv</span>
            ) : f.quarterlyCashBurnUsd ? (
              `-${formatCompactUsd(f.quarterlyCashBurnUsd)}/kvt.`
            ) : (
              <Missing text="ukendt" />
            )}
          </Row>
          <Row label="Runway" className={rl.tone === 'good' && !f.isCashFlowPositive ? TONE_CLASS.neutral : TONE_CLASS[rl.tone]}>
            {f.isCashFlowPositive || f.estimatedRunwayMonths === null ? (
              <span className="font-sans">Uendelig (overskud)</span>
            ) : rl.tone === 'unknown' ? (
              <Missing text="ukendt" />
            ) : (
              `${f.estimatedRunwayMonths} mdr.`
            )}
          </Row>
        </Pillar>

        <Pillar
          title="Short interest"
          aside={
            highShort ? (
              <Chip tone="accent" icon={Flame}>
                Høj short-andel
              </Chip>
            ) : null
          }
          note={f.shortPercentOfFloat === undefined ? 'Short-andel ukendt' : f.shortPercentOfFloat >= 12 ? 'Short squeeze-kandidat' : 'Normal short-andel'}
        >
          <Row label="Short-andel af float" className={highShort ? 'text-accent' : undefined}>
            {f.shortPercentOfFloat !== undefined ? `${dk(f.shortPercentOfFloat, 1)} %` : <Missing />}
          </Row>
          <Row label="Dage til dækning">{f.daysToCover !== undefined ? `${f.daysToCover.toLocaleString('da-DK')} d` : <Missing />}</Row>
        </Pillar>

        <Pillar title="Regnskab og multipler">
          <Row label="Næste regnskab">
            {f.nextEarningsDate ? (
              <>
                {f.nextEarningsDate.substring(5)}
                {f.daysUntilEarnings !== undefined ? ` (+${f.daysUntilEarnings} d)` : ''}
                {f.nextEarningsDateEstimated ? (
                  <span className="font-sans text-graphite" title="Estimeret dato (Nasdaq/Zacks), ikke bekræftet af selskabet">
                    {' '}
                    est.
                  </span>
                ) : null}
              </>
            ) : (
              <Missing />
            )}
          </Row>
          <Row label="P/E">{f.peRatio === undefined ? <Missing /> : f.peRatio === null ? <span className="font-sans">Negativ</span> : dk(f.peRatio, 1)}</Row>
          <Row label="P/B">{f.priceToBook !== null && f.priceToBook !== undefined ? dk(f.priceToBook, 2) : <Missing />}</Row>
        </Pillar>
      </div>
    </section>
  );
}

function Pillar({ title, aside, note, children }: { title: string; aside?: React.ReactNode; note?: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface p-3">
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <h4 className="text-xs text-graphite">{title}</h4>
        {aside}
      </div>
      <dl className="mt-1.5 space-y-0.5 text-sm">{children}</dl>
      {note && <p className="mt-1.5 border-t border-line pt-1.5 text-xs text-graphite">{note}</p>}
    </div>
  );
}

function Row({ label, strong = false, className = 'text-ink', children }: { label: string; strong?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-graphite">{label}</dt>
      <dd className={`text-right font-mono ${strong ? 'font-medium' : ''} ${className}`}>{children}</dd>
    </div>
  );
}
