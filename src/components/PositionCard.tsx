import { AlertTriangle, ExternalLink, Loader2, Pencil, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { CouncilVerdict, PaperTradePosition, PaperTradeStatus } from '@/types/insider';
import { PositionVerdict } from '@/components/PositionVerdict';
import { btn, Card, Chip, input, type Tone } from '@/components/ui';
import { curLabel, formatDateTimeDk, formatQuoteTime, stripEmoji, TONE_CLASS } from '@/lib/ui-labels';
import { currencyForTicker } from '@/lib/live-quote';

/** Samme form som editForm-state i page.tsx. */
export interface PositionEditForm {
  tradeType: 'PAPER' | 'REAL_NORDNET';
  entryPrice: number;
  shares: number;
  stopLossPrice: number;
  targetPrice: number;
}

export interface PositionCardProps {
  pos: PaperTradePosition;
  /** latestValidatedVerdict(verdictHistory, pos.ticker) */
  latestVerdict: { verdict: CouncilVerdict; at: string | undefined } | null;
  editingPosId: string | null;
  setEditingPosId: (id: string | null) => void;
  editForm: PositionEditForm;
  setEditForm: React.Dispatch<React.SetStateAction<PositionEditForm>>;
  isSavingEdit: boolean;
  onStartEdit: (pos: PaperTradePosition) => void;
  onSaveEdit: (id: string) => void;
  onClosePaperTrade: (id: string) => void;
}

const STATUS: Record<PaperTradeStatus, { label: string; tone: Tone }> = {
  OPEN: { label: 'Aktiv position', tone: 'accent' },
  STOPPED_OUT: { label: 'Stop-loss udløst', tone: 'loss' },
  TARGET_HIT: { label: 'Kursmål nået', tone: 'gain' },
  CLOSED_MANUAL: { label: 'Lukket', tone: 'neutral' },
};

const signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toLocaleString('da-DK')}`;
const pnlTone = (n: number) => (n >= 0 ? 'text-gain' : 'text-loss');
const linkCls = 'inline-flex items-center gap-1 text-sm text-accent underline-offset-2 hover:underline';

/** Én position i porteføljen. Kun visning – alle handlinger kommer ind som callbacks fra page.tsx. */
export function PositionCard({
  pos,
  latestVerdict,
  editingPosId,
  setEditingPosId,
  editForm,
  setEditForm,
  isSavingEdit,
  onStartEdit,
  onSaveEdit,
  onClosePaperTrade,
}: PositionCardProps) {
  // Samme valuta som serveren regner positionen i (portfolio.ts: currencyForTicker) – også EUR (.HE) og NOK (.OL).
  const currencyCode = currencyForTicker(pos.ticker);
  const currSym = curLabel(currencyCode);
  const isDkk = currencyCode === 'DKK';

  // Stop-loss -> entry -> kursmål på én skala
  const minP = pos.stopLossPrice > 0 ? pos.stopLossPrice : pos.entryPrice * 0.85;
  const maxP = pos.targetPrice > 0 ? pos.targetPrice : pos.entryPrice * 1.5;
  const span = Math.max(0.01, maxP - minP);
  const currPct = Math.min(100, Math.max(0, ((pos.currentPrice - minP) / span) * 100));
  const entryPct = Math.min(100, Math.max(0, ((pos.entryPrice - minP) / span) * 100));

  const isProfit = pos.pnlDkk >= 0;
  const isBelowInsider = typeof pos.insiderBuyPrice === 'number' && pos.insiderBuyPrice > 0 && pos.currentPrice < pos.insiderBuyPrice;

  const nordnetUrl = isDkk
    ? `https://www.nordnet.dk/markedet/aktier/${encodeURIComponent(pos.ticker)}`
    : `https://www.nordnet.dk/markedet/aktier?query=${encodeURIComponent(pos.ticker)}`;
  const yahooUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(pos.ticker)}`;

  const editing = editingPosId === pos.id;
  const status = STATUS[pos.status] ?? { label: 'Lukket', tone: 'neutral' as Tone };
  const openedScore = pos.openedScore ?? pos.asymmetryScore;
  const exit = pos.insiderExitWarning;
  const cur = currSym.trim();

  return (
    <Card className="@container space-y-4 p-4">
      {/* Hoved */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-cond text-xl font-semibold">{pos.ticker}</span>
            <span className="truncate text-sm text-graphite">{pos.companyName}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {pos.exchange && <Chip>{pos.exchange}</Chip>}
            {pos.tradeType === 'REAL_NORDNET' ? <Chip tone="accent">Nordnet Live · rigtig handel</Chip> : <Chip>Paper-trade</Chip>}
            <Chip tone={status.tone}>{status.label}</Chip>
            {pos.priceAlert && (
              <Chip
                tone={pos.priceAlert === 'STOP' ? 'loss' : 'gain'}
                icon={AlertTriangle}
                title="Rigtig position: status ændres ikke automatisk – handl selv på Nordnet"
              >
                {pos.priceAlert === 'STOP' ? 'Kursen er under dit stop' : 'Kursmål nået – overvej salg'}
              </Chip>
            )}
            <Chip title="Rådets score, da positionen blev åbnet">
              Score ved åbning <span className="font-mono">{openedScore}/100</span>
            </Chip>
            <PositionVerdict openedScore={openedScore} latest={latestVerdict} />
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => (editingPosId === pos.id ? setEditingPosId(null) : onStartEdit(pos))}
            aria-expanded={editing}
            className={btn.secondary}
            title="Redigér position for at matche din reelle Nordnet handel"
          >
            <Pencil className="size-4" aria-hidden />
            {editing ? 'Luk redigering' : 'Redigér'}
          </button>
          <button type="button" onClick={() => onClosePaperTrade(pos.id)} className={btn.quiet} title="Luk positionen til aktuel kurs. Den markeres som lukket med exit-kurs og realiseret P&L – intet slettes.">
            Luk position
          </button>
        </div>
      </div>

      {/* Fire nøgletal */}
      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-md border border-line bg-line @sm:grid-cols-2 @3xl:grid-cols-4">
        <Box label="Dit afkast">
          <dd className={`font-mono text-lg ${pnlTone(pos.pnlDkk)}`}>
            {isProfit ? '+' : ''}
            {pos.pnlPct.toLocaleString('da-DK')} %
          </dd>
          <dd className="text-xs text-graphite">
            <span className={`font-mono ${pnlTone(pos.pnlDkk)}`}>
              {isProfit ? '+' : ''}
              {pos.pnlDkk.toLocaleString('da-DK')} kr.
            </span>{' '}
            {isProfit ? 'gevinst' : 'tab'}
          </dd>
          <dd className="text-xs text-graphite">
            Entry{' '}
            <span className="font-mono text-ink">
              {currSym}
              {pos.entryPrice}
            </span>{' '}
            → nu{' '}
            <span className="font-mono text-ink">
              {currSym}
              {pos.currentPrice}
            </span>
          </dd>
          <dd className="text-xs text-graphite">
            Alpha{' '}
            {typeof pos.alphaPct === 'number' ? (
              <>
                <span className={`font-mono ${pnlTone(pos.alphaPct)}`}>{signed(pos.alphaPct)} %</span> (SPY i DKK:{' '}
                <span className="font-mono">
                  {typeof pos.benchmarkReturnPct === 'number' ? `${signed(pos.benchmarkReturnPct)} %` : 'N/A'}
                </span>
                )
              </>
            ) : (
              <span className="font-mono" title="SPY-kurs eller USD/DKK ved entry mangler">
                N/A
              </span>
            )}
          </dd>
        </Box>

        <Box label="Insiderens køb">
          <dd className="font-mono text-lg">
            {currSym}
            {pos.insiderBuyPrice || pos.entryPrice}
          </dd>
          <dd className="truncate text-xs text-graphite" title={`${pos.insiderName} (${pos.insiderTitle})`}>
            {pos.insiderName} ({pos.insiderTitle})
          </dd>
          <dd className="text-xs text-graphite">
            Insiderens P&amp;L{' '}
            {Number.isFinite(pos.insiderPnlPct) ? (
              <span className={`font-mono ${pnlTone(pos.insiderPnlPct)}`}>{signed(pos.insiderPnlPct)} %</span>
            ) : (
              <span className={`font-mono ${TONE_CLASS.unknown}`}>N/A</span>
            )}
          </dd>
          {isBelowInsider && (
            <dd>
              <Chip tone="gain">Rabat ift. insider</Chip>
            </dd>
          )}
        </Box>

        <Box label="Allokering">
          <dd className="text-lg">
            <span className="font-mono">{pos.shares}</span> aktier
          </dd>
          <dd className="text-xs text-graphite">
            <span className="font-mono text-ink">{pos.investedDkk.toLocaleString('da-DK')} kr.</span> investeret
          </dd>
          <dd className="text-xs text-graphite">
            Værdi nu{' '}
            {pos.currentFxRateDkk > 0 ? (
              <span className="font-mono text-ink">
                {Math.round(pos.shares * pos.currentPrice * pos.currentFxRateDkk).toLocaleString('da-DK')} kr.
              </span>
            ) : (
              'mangler valutakurs'
            )}
          </dd>
        </Box>

        <Box label="Risiko og mål">
          <dd className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-graphite">Stop</span>
            <span className="font-mono text-loss">
              {currSym}
              {pos.stopLossPrice}
            </span>
          </dd>
          <dd className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-graphite">Mål</span>
            <span className="font-mono text-gain">
              {currSym}
              {pos.targetPrice}
            </span>
          </dd>
          <dd className="text-xs text-graphite">
            Åbnet <span className="font-mono">{new Date(pos.openedAt).toLocaleDateString('da-DK')}</span>
          </dd>
        </Box>
      </dl>

      {/* Exit-radar. "Ikke tjekket", fejl og "0 salg" er forskellige tilstande – kun NO_SALES er grøn. */}
      {exit?.hasExit ? (
        <div className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-loss/50 p-3 text-sm">
          <p className="flex min-w-0 items-start gap-2">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-loss" aria-hidden />
            <span>
              <span className="font-medium text-loss">Insider-exit detekteret:</span> {stripEmoji(exit.message)}
            </span>
          </p>
          <Chip tone="loss">Exit-alarm</Chip>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border border-line px-3 py-2 text-sm">
          {exit?.status === 'NO_SALES' ? (
            <p className="flex min-w-0 items-start gap-1.5 text-gain">
              <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>Exit-radar: {stripEmoji(exit.message)}</span>
            </p>
          ) : exit?.status === 'SALES_FOUND' ? (
            <p className="flex min-w-0 items-start gap-1.5">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-graphite" aria-hidden />
              <span>Exit-radar: kun planlagte salg/10 %-ejere – {stripEmoji(exit.message)}</span>
            </p>
          ) : exit?.status === 'ERROR' ? (
            <p className="flex min-w-0 items-start gap-1.5 text-loss">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{stripEmoji(exit.message)}</span>
            </p>
          ) : exit?.status === 'UNSUPPORTED' ? (
            <p className="min-w-0 text-graphite">Exit-radar: {stripEmoji(exit.message)}</p>
          ) : (
            <p className="min-w-0">Exit-radar: ikke tjekket endnu – tryk &quot;Opdatér kurser&quot;</p>
          )}
          {exit?.checkedAt && (
            <span className="shrink-0 text-xs text-graphite">
              Tjekket <span className="font-mono">{formatDateTimeDk(exit.checkedAt)}</span>
            </span>
          )}
        </div>
      )}

      {/* Redigering (Nordnet-match) */}
      {editing && (
        <section aria-label={`Redigér ${pos.ticker}`} className="space-y-3 rounded-md border border-accent/50 bg-paper p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 className="text-sm font-semibold">Manuel redigering og Nordnet-match for {pos.ticker}</h3>
            <span className="text-xs text-graphite">Opdaterer straks investering og P&amp;L</span>
          </div>

          <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2 @3xl:grid-cols-5">
            <Field label="Handelstype">
              <select
                value={editForm.tradeType}
                onChange={(e) =>
                  setEditForm((prev) => ({
                    ...prev,
                    tradeType: e.target.value as 'PAPER' | 'REAL_NORDNET',
                  }))
                }
                className={`${input} w-full`}
              >
                <option value="PAPER">Paper-trade</option>
                <option value="REAL_NORDNET">Nordnet Live</option>
              </select>
            </Field>

            <Field label={`Min købskurs (${cur})`}>
              <input
                type="number"
                step="any"
                value={editForm.entryPrice}
                onChange={(e) => setEditForm((prev) => ({ ...prev, entryPrice: parseFloat(e.target.value) || 0 }))}
                className={`${input} w-full font-mono`}
              />
            </Field>

            <Field label="Antal aktier">
              <input
                type="number"
                step="1"
                value={editForm.shares}
                onChange={(e) => setEditForm((prev) => ({ ...prev, shares: parseInt(e.target.value, 10) || 0 }))}
                className={`${input} w-full font-mono`}
              />
            </Field>

            <Field label={`Stop-loss (${cur})`}>
              <input
                type="number"
                step="any"
                value={editForm.stopLossPrice}
                onChange={(e) => setEditForm((prev) => ({ ...prev, stopLossPrice: parseFloat(e.target.value) || 0 }))}
                className={`${input} w-full font-mono`}
              />
            </Field>

            <Field label={`Kursmål (${cur})`}>
              <input
                type="number"
                step="any"
                value={editForm.targetPrice}
                onChange={(e) => setEditForm((prev) => ({ ...prev, targetPrice: parseFloat(e.target.value) || 0 }))}
                className={`${input} w-full font-mono`}
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
            <button type="button" onClick={() => setEditingPosId(null)} className={btn.quiet}>
              Annullér
            </button>
            <button type="button" disabled={isSavingEdit} onClick={() => onSaveEdit(pos.id)} className={btn.primary}>
              {isSavingEdit && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {isSavingEdit ? 'Gemmer …' : 'Gem ændringer'}
            </button>
          </div>
        </section>
      )}

      {/* Stop-loss – entry – kursmål */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-xs text-graphite">
          <span>
            Stop-loss{' '}
            <span className="font-mono text-loss">
              {currSym}
              {pos.stopLossPrice}
            </span>
          </span>
          <span>
            Din entry{' '}
            <span className="font-mono text-ink">
              {currSym}
              {pos.entryPrice}
            </span>
          </span>
          <span>
            Mål{' '}
            <span className="font-mono text-gain">
              {currSym}
              {pos.targetPrice}
            </span>
          </span>
        </div>
        <div
          role="img"
          aria-label={`Kurs ${currSym}${pos.currentPrice} på skalaen fra stop-loss til mål. Din entry: ${currSym}${pos.entryPrice}.`}
          className="relative h-2 overflow-hidden rounded-full bg-line"
        >
          <div className={`h-full ${isProfit ? 'bg-gain/60' : 'bg-loss/60'}`} style={{ width: `${currPct}%` }} />
          <div className="absolute inset-y-0 w-0.5 bg-ink" style={{ left: `${entryPct}%` }} title={`Entry-kurs: ${currSym}${pos.entryPrice}`} />
        </div>
      </div>

      {/* Verifikation: seneste kurs, tidsstempel, kilde, valuta og eksterne links */}
      <div className="flex flex-col gap-2 border-t border-line pt-3 @3xl:flex-row @3xl:items-center @3xl:justify-between">
        {/* Ingen "verificeret": en fejlet opdatering beholder den gamle kurs – tidspunktet står ved siden af. */}
        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-graphite">
          <div>
            <dt className="inline">Seneste kurs </dt>
            <dd className="inline font-mono text-ink">
              {currSym}
              {pos.currentPrice}
            </dd>
          </div>
          <div>
            <dt className="inline">Seneste børs-tick </dt>
            <dd className="inline font-mono text-ink">{formatQuoteTime(pos.lastQuoteTime)}</dd>
          </div>
          <div>
            <dt className="inline">Kilde </dt>
            <dd className="inline text-ink">{pos.quoteSource || 'ukendt'}</dd>
          </div>
          <div>
            <dt className="inline">Valuta </dt>
            <dd className="inline text-ink">
              {pos.currentFxRateDkk > 0 ? (
                <span className="font-mono">
                  1 {currencyCode} = {Number(pos.currentFxRateDkk).toLocaleString('da-DK', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} DKK
                </span>
              ) : (
                'mangler live valutakurs'
              )}
            </dd>
          </div>
        </dl>
        <div className="flex shrink-0 gap-x-4">
          <a href={nordnetUrl} target="_blank" rel="noopener noreferrer" className={linkCls} title="Tjek kursen live hos Nordnet">
            Nordnet <ExternalLink className="size-3" aria-hidden />
          </a>
          <a href={yahooUrl} target="_blank" rel="noopener noreferrer" className={linkCls} title="Tjek kursen live hos Yahoo Finance">
            Yahoo Finance <ExternalLink className="size-3" aria-hidden />
          </a>
        </div>
      </div>
    </Card>
  );
}

function Box({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1 bg-surface p-3">
      <dt className="text-xs text-graphite">{label}</dt>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-0 space-y-1">
      <span className="block text-xs text-graphite">{label}</span>
      {children}
    </label>
  );
}
