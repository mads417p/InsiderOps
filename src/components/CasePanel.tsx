import { Check, Download, ExternalLink, Loader2, RefreshCw, Scale } from 'lucide-react';
import type { CouncilVerdict, InsiderTransaction } from '@/types/insider';
import type { CostsConfig } from '@/lib/costs';
import { roundTripCost } from '@/lib/round-trip';
import { currencyForTicker } from '@/lib/live-quote';
import { formatDailyVolume, formatDateTimeDk, getRegionBadge, marketPriceLabel, priceLabel, stripEmoji, verdictLabel } from '@/lib/ui-labels';
import { BreakEven } from '@/components/BreakEven';
import { btn, Card, Chip, Label, VerdictChip } from '@/components/ui';

const linkCls = 'inline-flex items-center gap-1 text-sm text-accent underline-offset-2 hover:underline';

/**
 * Sagen: én transaktion med rådets dom, break-even og handelsplan. Vises i højre-panelet (desktop) eller
 * som fuldskærmsark (mobil). Kun visning – alle handlinger kommer ind som callbacks fra page.tsx.
 */
export function CasePanel({
  tx,
  verdict,
  preScore,
  loading,
  costs,
  planCost,
  judgeTier,
  onJudgeTier,
  onConvene,
  onReevaluate,
  onCopyMemo,
  onDownloadMemo,
  memoCopied,
  children,
}: {
  tx: InsiderTransaction;
  verdict: CouncilVerdict | null;
  preScore?: { score: number; model: boolean; reasoning?: string };
  loading: boolean;
  costs: CostsConfig;
  /** Omkostning fra en aktiv handelsplan; ellers bruges standard-handelsstørrelsen. */
  planCost?: { pct: number; dkk: number; liquidityKnown: boolean; orders: number };
  judgeTier: 'opus' | 'sonnet';
  onJudgeTier: (t: 'opus' | 'sonnet') => void;
  onConvene: () => void;
  onReevaluate: () => void;
  onCopyMemo: () => void;
  onDownloadMemo: () => void;
  memoCopied: boolean;
  children?: React.ReactNode;
}) {
  const region = getRegionBadge(tx.ticker, tx.exchange);
  // Break-even uden plan: standard-handelsstørrelsen fra costs.json og én købsordre (samme formel som planen).
  const stdCost = roundTripCost(costs, { currency: currencyForTicker(tx.ticker), avgDailyDollarVolume: tx.avgDailyDollarVolume });

  return (
    <>
      {/* Hoved */}
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-cond text-2xl font-semibold">{tx.ticker}</span>
              <span className="truncate text-sm text-graphite">{tx.companyName}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <Chip title={region.label}>{region.code}</Chip>
              {tx.exchange && (
                <Chip tone={tx.isTradableInDK === true ? 'neutral' : tx.isTradableInDK === false ? 'loss' : 'unknown'} title={tx.tradabilityReason}>
                  {tx.isTradableInDK === true ? 'Handelbar i DK' : tx.isTradableInDK === false ? 'Ikke godkendt i DK' : 'Handelbarhed: mangler data'} ·{' '}
                  {tx.exchange}
                </Chip>
              )}
              {tx.is10b51Plan && (
                <Chip tone="loss" title="Form 4 indberetter handlen som forudbestemt automatisk program (0 % aktuel asymmetri)">
                  10b5-1-plan
                </Chip>
              )}
            </div>
          </div>
          <div className="shrink-0 text-right">
            {verdict ? (
              <>
                <div className="font-mono text-2xl">
                  {verdict.previousScore !== undefined && verdict.previousScore !== verdict.asymmetryScore && (
                    <span className="text-sm text-graphite">{verdict.previousScore} → </span>
                  )}
                  {verdict.asymmetryScore}
                  <span className="text-sm text-graphite">/100</span>
                </div>
                <VerdictChip verdict={verdict} />
              </>
            ) : preScore ? (
              <Label>
                Pre-score <span className="font-mono text-ink">{preScore.score}</span>
                {!preScore.model && ' · heuristik'}
              </Label>
            ) : null}
          </div>
        </div>

        <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <dt className="text-graphite">Insider</dt>
          <dd className="truncate">
            {tx.insiderName} <span className="text-graphite">· {tx.insiderTitle}</span>
          </dd>
          <dt className="text-graphite">Køb</dt>
          <dd>
            <span className="font-mono">${Math.round(tx.totalValueUsd).toLocaleString('da-DK')}</span>{' '}
            <span className="text-graphite">
              · <span className="font-mono">{tx.shares.toLocaleString('da-DK')}</span> á{' '}
              <span className="font-mono">
                {priceLabel(tx)}
                {tx.pricePerShare}
              </span>
            </span>
          </dd>
          <dt className="text-graphite">Kurs nu</dt>
          <dd>
            {tx.currentMarketPrice !== undefined ? (
              <span className="font-mono">{`${marketPriceLabel(tx.ticker)}${tx.currentMarketPrice}`}</span>
            ) : (
              <span className="text-graphite">mangler kurs</span>
            )}
            {tx.returnSinceBuyPct !== undefined && (
              <span className="text-graphite">
                {' '}
                · <span className="font-mono">{`${tx.returnSinceBuyPct > 0 ? '+' : ''}${tx.returnSinceBuyPct.toLocaleString('da-DK')} %`}</span> siden
                køb
              </span>
            )}
          </dd>
          <dt className="text-graphite">Beholdning</dt>
          <dd className="font-mono">
            {tx.holdingsIncreasePct === undefined ? (
              <span className="font-sans text-graphite">ukendt</span>
            ) : (
              `${tx.holdingsIncreasePct > 0 ? '+' : ''}${tx.holdingsIncreasePct.toLocaleString('da-DK')} %`
            )}
          </dd>
          <dt className="text-graphite">Likviditet</dt>
          <dd className="font-mono">{tx.avgDailyDollarVolume ? `${formatDailyVolume(tx.avgDailyDollarVolume)}/dag` : <span className="font-sans text-graphite">ukendt</span>}</dd>
        </dl>

        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <a className={linkCls} href={`https://finance.yahoo.com/quote/${encodeURIComponent(tx.ticker)}`} target="_blank" rel="noopener noreferrer">
            Yahoo Finance <ExternalLink className="size-3" aria-hidden />
          </a>
          <a
            className={linkCls}
            href={`https://www.nordnet.dk/markedet/aktiekurser?query=${encodeURIComponent(tx.ticker.replace(/\.(CO|ST)$/i, ''))}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Søg på Nordnet <ExternalLink className="size-3" aria-hidden />
          </a>
          {tx.secFilingUrl && (
            <a className={linkCls} href={tx.secFilingUrl} target="_blank" rel="noopener noreferrer">
              Indberetning <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
        </div>
      </div>

      {/* Handlinger */}
      <div className="flex flex-wrap items-center gap-2 border-y border-line py-3">
        {verdict ? (
          <button type="button" onClick={onReevaluate} disabled={loading} className={btn.secondary} title="Henter frisk kurs og 14d ATR og kører en ny rådsdom">
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
            Ny vurdering
          </button>
        ) : (
          <button type="button" onClick={onConvene} disabled={loading} className={btn.primary}>
            <Scale className="size-4" aria-hidden />
            Send til rådet
          </button>
        )}
        <div className="flex items-center gap-1.5" title="Skift starter en ny vurdering med den valgte dommer">
          <span className="text-xs text-graphite">Dommer</span>
          <div role="radiogroup" aria-label="Dommer" className="inline-flex rounded-md bg-line/50 p-0.5">
            {(['opus', 'sonnet'] as const).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={judgeTier === t} onClick={() => onJudgeTier(t)} className={btn.seg(judgeTier === t)}>
                {t === 'opus' ? 'Opus' : 'Sonnet'}
              </button>
            ))}
          </div>
        </div>
        {verdict && (
          <div className="ml-auto flex gap-1">
            <button type="button" onClick={onCopyMemo} className={btn.quiet}>
              {memoCopied ? <Check className="size-4 text-gain" aria-hidden /> : null}
              {memoCopied ? 'Kopieret' : 'Kopiér notat'}
            </button>
            <button type="button" onClick={onDownloadMemo} className={btn.quiet}>
              <Download className="size-4" aria-hidden />
              Notat (.md)
            </button>
          </div>
        )}
      </div>

      {loading && (
        <Card className="flex items-start gap-3 p-4" role="status">
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-accent" aria-hidden />
          <div>
            <p className="text-sm font-medium">Rådet vurderer {tx.ticker}</p>
            <p className="text-sm text-graphite">Tre specialister arbejder parallelt: insider-profiløren, katalysator-jægeren og den kritiske skeptiker.</p>
          </div>
        </Card>
      )}

      {planCost ? (
        <BreakEven cost={planCost} basis={`ved handelsplanens ${planCost.orders} ordrer (køb og salg)`} />
      ) : (
        <BreakEven cost={stdCost} basis={`ved ${costs.assumedTradeSizeDkk.toLocaleString('da-DK')} kr. og én købsordre`} />
      )}

      {!loading && verdict && (
        <section aria-labelledby="verdict-title" className="space-y-2">
          <Label>
            Dommerens vurdering · <span className="font-mono">{formatDateTimeDk(verdict.evaluatedAt || verdict.timestamp)}</span>
            {verdict.priceAtEvaluation ? (
              <>
                {' '}
                @ <span className="font-mono">${verdict.priceAtEvaluation}</span>
              </>
            ) : null}
          </Label>
          <h3 id="verdict-title" className="text-lg font-semibold leading-snug">
            {stripEmoji(verdict.headline)}
          </h3>
          <p className="text-sm leading-relaxed">{stripEmoji(verdict.synthesis)}</p>
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-graphite">
            <span>{verdictLabel(verdict.verdict)}</span>
            <span>Gatekeeper: {verdict.modelsUsed?.gatekeeper || 'ukendt'}</span>
            <span>Specialister: {verdict.modelsUsed?.specialists || 'ukendt'} (×3)</span>
            <span>Dommer: {verdict.modelsUsed?.judge || 'ukendt'}</span>
            <span title={verdict.validated ? 'Dommerens output bestod skema-validering' : 'Ældre dom fra før fase 1 – ikke skema-valideret. Vurdér igen.'}>
              {verdict.validated ? `Valideret · ${verdict.promptVersion}` : 'Ikke valideret (ældre dom)'}
            </span>
          </p>
        </section>
      )}

      {!loading && !verdict && preScore?.reasoning && (
        <section className="space-y-1">
          <Label>Gatekeeperens begrundelse{preScore.model ? '' : ' (heuristik)'}</Label>
          <p className="text-sm leading-relaxed">{stripEmoji(preScore.reasoning)}</p>
          <p className="text-sm text-graphite">Ingen dom endnu. Tryk Send til rådet for at få en vurdering.</p>
        </section>
      )}

      {children}
    </>
  );
}

