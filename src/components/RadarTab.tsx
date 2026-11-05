'use client';

import { Loader2, RefreshCw, Search, X } from 'lucide-react';
import type { RejectedRow, SavedVerdictItem, ScanItem } from '@/types/insider';
import type { InsiderTransaction, CouncilVerdict } from '@/types/insider';
import { formatDateTimeDk, getRegionBadge, isModelScore, priceLabel, stripEmoji } from '@/lib/ui-labels';
import { RejectedNoisePanel } from '@/components/RejectedNoisePanel';
import { btn, Card, Chip, input, StatusChip } from '@/components/ui';

export type QuickFilter = 'all' | 'ceo_cfo' | 'csuite' | 'cluster_discount' | 'below_insider' | 'csuite_cluster';
export type RegionFilter = 'all' | 'us' | 'nordic';
export type RecTab = 'BUY' | 'WATCH' | 'REJECTED';

const QUICK_FILTERS: Array<{ id: QuickFilter; label: string; title?: string }> = [
  { id: 'all', label: 'Alle godkendte' },
  { id: 'ceo_cfo', label: 'CEO/CFO-køb', title: 'Køb, hvor CEO/VD eller CFO er køber (også i et cluster). Samme rolleregel som backtesten.' },
  { id: 'csuite', label: 'Kun direktion', title: 'C-suite / direktion (CEO, CFO, GC)' },
  { id: 'cluster_discount', label: 'Cluster og rabat' },
  { id: 'below_insider', label: 'Under insiderkurs' },
  { id: 'csuite_cluster', label: 'Direktion + cluster', title: 'Direktion eller cluster, mindst $100k' },
];

const CODE_TITLE: Record<string, string> = {
  P: 'Køb i markedet',
  M: 'Optionsudnyttelse / RSU',
  A: 'Tildeling',
  F: 'Skattesalg / tilbageholdelse',
};

const usd = (n: number) => `$${Math.round(n).toLocaleString('da-DK')}`;

export interface RadarTabProps {
  loading: boolean;
  scannedAt: string | null;
  activeTickerQuery: string | null;
  onScan: () => void;
  searchTicker: string;
  onSearchTicker: (v: string) => void;
  onTickerSearch: (e: React.FormEvent) => void;
  onResetSearch: () => void;
  stats: { scanned: number; rejected: RejectedRow[]; autoQueueCount: number; savedVerdicts: number };
  showRejected: boolean;
  onToggleRejected: () => void;
  // Rådet
  checkedIds: string[];
  setCheckedIds: React.Dispatch<React.SetStateAction<string[]>>;
  onSendSelected: () => void;
  queueRunning: boolean;
  autoQueue: { topN: number; minScore: number } | null;
  onAutoQueue: () => void;
  // Rådets vurderinger
  recommendations: Record<RecTab, SavedVerdictItem[]>;
  recTab: RecTab;
  onRecTab: (t: RecTab) => void;
  inPortfolio: (id: string) => boolean;
  // Radar-listen
  rows: ScanItem[];
  counts: Record<QuickFilter, number> & { us: number; nordic: number };
  quickFilter: QuickFilter;
  onQuickFilter: (f: QuickFilter) => void;
  regionFilter: RegionFilter;
  onRegionFilter: (r: RegionFilter) => void;
  verdictHistory: Record<string, SavedVerdictItem>;
  selectedId: string | null;
  councilLoading: boolean;
  onOpen: (tx: InsiderTransaction, verdict: CouncilVerdict | null) => void;
}

export function RadarTab(p: RadarTabProps) {
  const recList = p.recommendations[p.recTab];
  return (
    <div className="space-y-6">
      {/* Hoved og handlinger */}
      <header className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-cond text-xl font-semibold">Radar</h1>
            <p className="text-sm text-graphite">Insiderkøb fra SEC Form 4 og Norden (MAR 19)</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-graphite" title="Tidspunkt for den viste scan">
              {p.scannedAt ? (
                <>
                  Scannet <span className="font-mono">{formatDateTimeDk(p.scannedAt)}</span>
                </>
              ) : (
                'Ingen gemt scan'
              )}
            </span>
            <button type="button" onClick={p.onScan} disabled={p.loading || p.queueRunning} className={btn.secondary}>
              <RefreshCw className={`size-4 ${p.loading ? 'animate-spin' : ''}`} aria-hidden />
              Scan nu
            </button>
          </div>
        </div>

        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-graphite">
          <div>
            <dt className="inline">Indberetninger </dt>
            <dd className="inline font-mono text-ink">{p.loading ? '–' : p.stats.scanned}</dd>
          </div>
          <div>
            <dt className="inline">Afvist af hårdt filter </dt>
            <dd className="inline font-mono text-ink">{p.loading ? '–' : p.stats.rejected.length}</dd>{' '}
            <button type="button" onClick={p.onToggleRejected} className="text-accent underline-offset-2 hover:underline">
              {p.showRejected ? 'skjul' : 'vis'}
            </button>
          </div>
          <div>
            <dt className="inline">I auto-kø </dt>
            <dd className="inline font-mono text-ink">{p.loading ? '–' : p.stats.autoQueueCount}</dd>
          </div>
          <div>
            <dt className="inline">Gemte domme </dt>
            <dd className="inline font-mono text-ink">{p.stats.savedVerdicts}</dd>
          </div>
        </dl>
        {p.showRejected && <RejectedNoisePanel rows={p.stats.rejected} />}

        <div className="flex flex-wrap items-center gap-2">
          <form onSubmit={p.onTickerSearch} className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:max-w-md sm:flex-1">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Ticker</span>
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-graphite" aria-hidden />
              <input
                type="text"
                value={p.searchTicker}
                onChange={(e) => p.onSearchTicker(e.target.value)}
                placeholder="US-ticker, fx NVDA"
                className={`${input} w-full pl-8 font-mono`}
              />
            </label>
            <button type="submit" disabled={p.loading || !p.searchTicker.trim()} className={btn.secondary}>
              Scan ticker
            </button>
          </form>
          {p.activeTickerQuery && (
            <Chip tone="accent">
              Viser ticker <span className="font-mono">{p.activeTickerQuery}</span>
              <button type="button" onClick={p.onResetSearch} aria-label="Ryd søgning" className="-mr-0.5 hover:text-ink">
                <X className="size-3.5" />
              </button>
            </Chip>
          )}
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            <button
              type="button"
              onClick={p.onAutoQueue}
              disabled={p.loading || p.queueRunning || p.stats.autoQueueCount === 0}
              className={btn.secondary}
              title={
                p.autoQueue
                  ? `Rangregel: de ${p.autoQueue.topN} højest Claude-scorede rækker i scannen med score ≥ ${p.autoQueue.minScore}, som endnu ikke har en dom`
                  : 'Auto-køen beregnes ved scan'
              }
            >
              Auto-kø: top {p.autoQueue?.topN ?? '–'} ≥ {p.autoQueue?.minScore ?? '–'}{' '}
              <span className="font-mono">({p.stats.autoQueueCount})</span>
            </button>
            <button
              type="button"
              onClick={p.onSendSelected}
              disabled={p.loading || p.queueRunning || p.checkedIds.length === 0}
              className={btn.primary}
              title="Kør rådet på de afkrydsede rækker (gen-vurderer med frisk kurs, hvis de har en gammel dom)"
            >
              Send til rådet <span className="font-mono">({p.checkedIds.length})</span>
            </button>
          </div>
        </div>
      </header>

      {/* Rådets vurderinger (tidligere "top picks") */}
      <section aria-labelledby="rec-title" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 id="rec-title" className="text-base font-semibold">
              Rådets vurderinger
            </h2>
            <p className="text-xs text-graphite">Et signal, ikke en dokumenteret købsanbefaling.</p>
          </div>
          <div role="tablist" aria-label="Filtrér vurderinger" className="inline-flex rounded-md bg-line/50 p-0.5">
            {(
              [
                ['BUY', 'Stærkt signal'],
                ['WATCH', 'Overvåg'],
                ['REJECTED', 'Støj'],
              ] as Array<[RecTab, string]>
            ).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={p.recTab === id} onClick={() => p.onRecTab(id)} className={btn.seg(p.recTab === id)}>
                {label} <span className="font-mono text-xs text-graphite">{p.recommendations[id].length}</span>
              </button>
            ))}
          </div>
        </div>
        <Card>
          {recList.length === 0 ? (
            <p className="p-4 text-sm text-graphite">
              {p.recTab === 'BUY'
                ? 'Ingen stærke signaler endnu. Kryds rækker af i radaren nedenfor, og tryk Send til rådet.'
                : p.recTab === 'WATCH'
                ? 'Ingen aktier i Overvåg (score 60–74).'
                : 'Ingen aktier vurderet som støj (score under 60).'}
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {recList.map(({ transaction: tx, verdict, savedAt }) => (
                <li key={tx.id}>
                  <button
                    type="button"
                    onClick={() => p.onOpen(tx, verdict)}
                    aria-current={p.selectedId === tx.id ? 'true' : undefined}
                    className={`grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-l-2 px-4 py-2.5 text-left hover:bg-paper ${
                      p.selectedId === tx.id ? 'border-accent bg-paper' : 'border-transparent'
                    }`}
                  >
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="font-cond text-base font-semibold">{tx.ticker}</span>
                      <span className="truncate text-sm text-graphite">{tx.companyName}</span>
                    </span>
                    <span className="flex items-center gap-1.5 justify-self-end">
                      {p.inPortfolio(tx.id) && <Chip>I portefølje</Chip>}
                      <StatusChip score={verdict.asymmetryScore} />
                    </span>
                    <span className="truncate text-sm text-graphite">{stripEmoji(verdict.headline)}</span>
                    <span className="justify-self-end font-mono text-xs text-graphite">
                      {formatDateTimeDk(verdict.evaluatedAt || verdict.timestamp || savedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {/* Radar-listen */}
      <section aria-labelledby="radar-title" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="radar-title" className="text-base font-semibold">
            Insiderkøb <span className="font-mono text-sm font-normal text-graphite">{p.rows.length}</span>
          </h2>
          <div role="radiogroup" aria-label="Marked" className="inline-flex rounded-md bg-line/50 p-0.5">
            {(
              [
                ['all', 'Alle', p.counts.all],
                ['us', 'USA', p.counts.us],
                ['nordic', 'Norden', p.counts.nordic],
              ] as Array<[RegionFilter, string, number]>
            ).map(([id, label, n]) => (
              <button key={id} type="button" role="radio" aria-checked={p.regionFilter === id} onClick={() => p.onRegionFilter(id)} className={btn.seg(p.regionFilter === id)}>
                {label} <span className="font-mono text-xs text-graphite">{n}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Hurtigfilter">
          {QUICK_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={p.quickFilter === f.id}
              onClick={() => p.onQuickFilter(f.id)}
              title={f.title}
              className={`rounded-full border px-2.5 py-0.5 text-sm ${
                p.quickFilter === f.id ? 'border-accent bg-surface text-accent' : 'border-line text-graphite hover:text-ink'
              }`}
            >
              {f.label} <span className="font-mono text-xs">{p.counts[f.id]}</span>
            </button>
          ))}
        </div>

        <Card className="@container overflow-hidden">
          <div className="hidden @xl:grid grid-cols-[2rem_minmax(0,1.2fr)_minmax(0,1.3fr)_2.5rem_minmax(0,1fr)_8.5rem] gap-3 border-b border-line px-3 py-2 text-xs text-graphite">
            <label className="flex items-center justify-center">
              <span className="sr-only">Vælg alle viste</span>
              <input
                type="checkbox"
                className="accent-[var(--accent)]"
                checked={p.rows.length > 0 && p.rows.every((r) => p.checkedIds.includes(r.transaction.id))}
                onChange={(e) => p.setCheckedIds(e.target.checked ? p.rows.map((r) => r.transaction.id) : [])}
              />
            </label>
            <span>Ticker og selskab</span>
            <span>Insider og rolle</span>
            <span className="text-center">Kode</span>
            <span className="text-right">Beløb og kurs</span>
            <span className="text-right">Status</span>
          </div>
          {p.loading ? (
            <p className="flex items-center justify-center gap-2 p-10 text-sm text-graphite">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {p.activeTickerQuery ? `Henter Form 4-indberetninger for ${p.activeTickerQuery} …` : 'Scanner indberetninger og kører gatekeeperen …'}
            </p>
          ) : p.rows.length === 0 ? (
            <p className="p-10 text-center text-sm text-graphite">
              Ingen handler at vise. Skift filter, eller tryk Scan nu for at hente nye insiderkøb.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {p.rows.map(({ transaction: tx, result: res }) => (
                <RadarRow
                  key={tx.id}
                  tx={tx}
                  res={res}
                  saved={p.verdictHistory[tx.id]}
                  selected={p.selectedId === tx.id}
                  working={p.councilLoading && p.selectedId === tx.id}
                  checked={p.checkedIds.includes(tx.id)}
                  onCheck={(on) => p.setCheckedIds((prev) => (on ? [...prev, tx.id] : prev.filter((id) => id !== tx.id)))}
                  onOpen={() => p.onOpen(tx, p.verdictHistory[tx.id]?.verdict ?? null)}
                />
              ))}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}

function RadarRow({
  tx,
  res,
  saved,
  selected,
  working,
  checked,
  onCheck,
  onOpen,
}: {
  tx: InsiderTransaction;
  res: ScanItem['result'];
  saved: SavedVerdictItem | undefined;
  selected: boolean;
  working: boolean;
  checked: boolean;
  onCheck: (on: boolean) => void;
  onOpen: () => void;
}) {
  const region = getRegionBadge(tx.ticker, tx.exchange);
  return (
    <li className={`grid grid-cols-[2rem_minmax(0,1fr)] border-l-2 ${selected ? 'border-accent bg-paper' : 'border-transparent hover:bg-paper'}`}>
      <label className="flex items-start justify-center pt-3.5">
        <span className="sr-only">Vælg {tx.ticker} til rådet</span>
        <input type="checkbox" className="accent-[var(--accent)]" checked={checked} onChange={(e) => onCheck(e.target.checked)} />
      </label>
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? 'true' : undefined}
        className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 py-2.5 pr-3 text-left @xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1.3fr)_2.5rem_minmax(0,1fr)_8.5rem] @xl:items-start"
      >
        {/* Ticker og selskab */}
        <span className="min-w-0">
          <span className="flex items-baseline gap-1.5">
            <span className="font-cond text-base font-semibold">{tx.ticker}</span>
            <span className="text-xs text-graphite" title={region.label}>
              {region.code}
            </span>
          </span>
          <span className="block truncate text-sm text-graphite">{tx.companyName}</span>
        </span>

        {/* Status (mobil: øverst til højre) */}
        <span className="flex flex-col items-end gap-1 @xl:order-last">
          {saved ? (
            <StatusChip score={saved.verdict.asymmetryScore} />
          ) : (
            <span className="text-xs text-graphite" title={isModelScore(res) ? 'Gatekeeperens pre-score' : 'Heuristisk score (gatekeeper-modellen svarede ikke) – starter ikke auto-køen'}>
              Pre-score <span className="font-mono text-ink">{res.geminiPreScore}</span>
              {!isModelScore(res) && ' · heuristik'}
            </span>
          )}
          {working && (
            <span className="flex items-center gap-1 text-xs text-accent">
              <Loader2 className="size-3 animate-spin" aria-hidden /> Rådet arbejder
            </span>
          )}
        </span>

        {/* Insider og rolle */}
        <span className="min-w-0 col-span-2 @xl:col-span-1">
          <span className="block truncate text-sm">{tx.insiderName}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1">
            <span className="truncate text-xs text-graphite">{tx.insiderTitle}</span>
            {tx.isClusterBuy && <Chip>Cluster {tx.clusterCount ?? 2}</Chip>}
            {tx.is10b51Plan && <Chip tone="loss" title="Handlet via forudbestemt Rule 10b5-1-plan">10b5-1-plan</Chip>}
            {tx.isTradableInDK === false && <Chip tone="loss" title={tx.tradabilityReason}>Ikke handelbar i DK</Chip>}
          </span>
        </span>

        {/* Kode */}
        <span className="hidden @xl:block text-center font-mono text-sm" title={CODE_TITLE[tx.transactionCode] ?? 'Salg'}>
          {tx.transactionCode}
        </span>

        {/* Beløb og kurs */}
        <span className="col-span-2 flex items-baseline justify-between gap-3 font-mono text-sm @xl:col-span-1 @xl:block @xl:text-right">
          <span className="block text-ink">{usd(tx.totalValueUsd)}</span>
          <span className="block text-xs text-graphite">
            {tx.shares.toLocaleString('da-DK')} á {priceLabel(tx)}
            {tx.pricePerShare}
          </span>
        </span>
      </button>
    </li>
  );
}
