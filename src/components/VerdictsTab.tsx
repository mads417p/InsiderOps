'use client';

import { Bookmark, RefreshCw, Scale, Trash2 } from 'lucide-react';
import type { SavedVerdictItem } from '@/types/insider';
import { formatDateTimeDk, marketPriceLabel, priceLabel, stripEmoji } from '@/lib/ui-labels';
import { btn, Card, Chip, Label, VerdictChip, type Tone } from '@/components/ui';

const signedPct = (n: number) => `${n > 0 ? '+' : ''}${n.toLocaleString('da-DK', { maximumFractionDigits: 2 })} %`;
// Som før: positivt afkast er grønt, negativt (rabat ift. insideren) er blåt – aldrig rødt. Fortegnet står altid som tekst.
const returnTone = (n: number): Tone => (n >= 0 ? 'gain' : 'accent');

export interface VerdictsTabProps {
  /** Gemte domme i den rækkefølge, de skal vises (page.tsx: savedVerdictItems, højeste score først). */
  items: SavedVerdictItem[];
  /** Gns. afkast siden insiderkøb for domme med "Stærkt signal" (page.tsx: avgStrongAlpha, toFixed(2)-streng). null = ingen data. */
  avgStrongAlpha: string | number | null;
  /** Sand, mens kurserne hentes (page.tsx: refreshingAlpha). */
  refreshing: boolean;
  /** Henter aktuelle kurser for alle gemte domme (page.tsx: handleRefreshWatchlistAlpha). */
  onRefresh: () => void;
  /** Fjerner en gemt dom (page.tsx: handleRemoveFromWatchlist). */
  onRemove: (id: string) => void;
  /** Åbner dommen i sagen (page.tsx: setSelectedTx + setActiveVerdict + scroll). */
  onOpen: (item: SavedVerdictItem) => void;
  /** Transaktionen, der er åben i sagen – markeres i listen. */
  selectedId?: string | null;
}

/** Fanen "Domme": gemte rådsdomme målt mod aktuel kurs. Kun visning – alle handlinger kommer ind som callbacks fra page.tsx. */
export function VerdictsTab({ items, avgStrongAlpha, refreshing, onRefresh, onRemove, onOpen, selectedId }: VerdictsTabProps) {
  const avg = avgStrongAlpha === null ? null : Number(avgStrongAlpha);

  return (
    <div className="@container space-y-6">
      {/* Hoved og handlinger */}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-cond text-xl font-semibold">Gemte domme</h1>
          <p className="text-sm text-graphite">Dine gemte sager målt mod aktuel markedskurs og insiderens købskurs.</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <dl
            className="text-sm"
            title="Gennemsnitligt afkast siden insiderens køb for domme med Stærkt signal, hvor den aktuelle kurs er kendt"
          >
            <dt className="inline text-graphite">Gns. insider-alpha, stærke signaler </dt>
            <dd className={`inline font-mono ${avg === null || Number.isNaN(avg) ? 'text-graphite' : avg >= 0 ? 'text-gain' : 'text-accent'}`}>
              {avg === null || Number.isNaN(avg) ? <span className="font-sans">mangler data</span> : signedPct(avg)}
            </dd>
          </dl>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing || items.length === 0}
            className={btn.secondary}
            title="Henter aktuelle kurser for alle gemte domme og opdaterer afkastet siden insiderens køb"
          >
            <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />
            Opdatér kurser
          </button>
        </div>
      </header>

      {items.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 px-6 py-12 text-center">
          <Bookmark className="size-6 text-graphite" aria-hidden />
          <p className="text-sm font-medium">Ingen rådsdomme er gemt endnu</p>
          <p className="max-w-md text-sm text-graphite">
            Gå til Radar, vælg en transaktion, og tryk Send til rådet. Dommen gemmes her, så du kan følge kursen bagefter.
          </p>
        </Card>
      ) : (
        <ul className="grid gap-3 @3xl:grid-cols-2">
          {items.map((item) => (
            <VerdictCard key={item.transaction.id} item={item} selected={selectedId === item.transaction.id} onRemove={onRemove} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </div>
  );
}

function VerdictCard({
  item,
  selected,
  onRemove,
  onOpen,
}: {
  item: SavedVerdictItem;
  selected: boolean;
  onRemove: (id: string) => void;
  onOpen: (item: SavedVerdictItem) => void;
}) {
  const { transaction: tx, verdict, savedAt } = item;
  const hasFlags = tx.isExecutiveOfficer || tx.ownershipNature === 'I' || tx.is10b51Plan || tx.isTradingBelowInsiderPrice;

  return (
    <li>
      <Card className={`flex h-full flex-col gap-3 p-4 ${selected ? 'ring-1 ring-accent' : ''}`}>
        {/* Ticker, selskab og score */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="font-cond text-lg font-semibold">{tx.ticker}</span>
            <span className="truncate text-sm text-graphite">{tx.companyName}</span>
          </div>
          <span className="shrink-0">
            <VerdictChip verdict={verdict} />
          </span>
        </div>

        {/* Insider og købet */}
        <div className="space-y-1.5 text-sm">
          <p className="min-w-0">
            {tx.insiderName} <span className="text-graphite">· {tx.insiderTitle}</span>
          </p>
          <p className="text-graphite">
            <span className="font-mono text-ink">${Math.round(tx.totalValueUsd).toLocaleString('da-DK')}</span> · beholdning{' '}
            {tx.holdingsIncreasePct !== undefined ? (
              <span className="font-mono text-ink">{signedPct(tx.holdingsIncreasePct)}</span>
            ) : (
              'ukendt'
            )}
          </p>
          {tx.currentMarketPrice !== undefined && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-graphite">
              <span>
                Købt{' '}
                <span className="font-mono text-ink">
                  {priceLabel(tx)}
                  {tx.pricePerShare}
                </span>{' '}
                → nu{' '}
                <span className="font-mono text-ink">
                  {marketPriceLabel(tx.ticker)}
                  {tx.currentMarketPrice}
                </span>
              </span>
              {tx.returnSinceBuyPct !== undefined && (
                <Chip tone={returnTone(tx.returnSinceBuyPct)} title="Afkast fra insiderens købskurs til aktuel kurs">
                  <span className="font-mono">{signedPct(tx.returnSinceBuyPct)}</span>
                </Chip>
              )}
            </p>
          )}
        </div>

        {hasFlags && (
          <div className="flex flex-wrap gap-1.5">
            {tx.isExecutiveOfficer && <Chip title="C-suite: CEO, CFO, COO, VP eller General Counsel">Direktion</Chip>}
            {tx.ownershipNature === 'I' && <Chip title={tx.ownershipVia}>Via fond (indirekte)</Chip>}
            {tx.is10b51Plan && (
              <Chip tone="loss" title="Handlet via forudbestemt Rule 10b5-1-plan">
                10b5-1-plan
              </Chip>
            )}
            {tx.isTradingBelowInsiderPrice && (
              <Chip tone="accent" title="Aktien handler under insiderens købskurs">
                Handler med rabat ift. insider
                {tx.returnSinceBuyPct !== undefined && <span className="font-mono">({signedPct(tx.returnSinceBuyPct)})</span>}
              </Chip>
            )}
          </div>
        )}

        {/* Dommen */}
        <div className="space-y-1">
          <h3 className="line-clamp-2 text-sm font-semibold leading-snug">{stripEmoji(verdict.headline)}</h3>
          <p className="line-clamp-3 text-sm leading-relaxed text-graphite">{stripEmoji(verdict.synthesis)}</p>
        </div>

        {/* Gemt og handlinger */}
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <Label>
            Gemt <span className="font-mono">{formatDateTimeDk(savedAt)}</span>
          </Label>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onRemove(tx.id)}
              className={btn.quiet}
              title="Fjern fra gemte domme"
              aria-label={`Fjern ${tx.ticker} fra gemte domme`}
            >
              <Trash2 className="size-4" aria-hidden />
              Fjern
            </button>
            <button type="button" onClick={() => onOpen(item)} aria-current={selected ? 'true' : undefined} className={btn.secondary}>
              <Scale className="size-4" aria-hidden />
              Åbn sagen
            </button>
          </div>
        </div>
      </Card>
    </li>
  );
}
