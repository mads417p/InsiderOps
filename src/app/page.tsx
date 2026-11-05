'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Activity, AlertTriangle, Bookmark, Briefcase, Loader2, Ruler, X } from 'lucide-react';
import {
  CouncilVerdict,
  GatekeeperUsage,
  InsiderTransaction,
  PaperTradePosition,
  PortfolioSummary,
  RealKpis,
  RejectedRow,
  SavedVerdictItem,
  ScanItem,
  TradeType,
} from '@/types/insider';
import { generateTradeExecutionPlan } from '@/lib/trade-planner';
import type { CostsConfig } from '@/lib/costs';
import costsJson from '../../config/costs.json';
import { collectRejected, curLabel, formatDateTimeDk, isCeoCfoBuy, isModelScore } from '@/lib/ui-labels';
import { generateInvestmentMemoMarkdown as buildMemo, HOLD_NOTE } from '@/lib/investment-memo';
import { currencyForTicker, type LiveFxRates } from '@/lib/live-quote';
import { AppShell, type NavTab } from '@/components/AppShell';
import { RadarTab } from '@/components/RadarTab';
import { CasePanel } from '@/components/CasePanel';
import { TradePlanCard } from '@/components/TradePlanCard';
import { MeasurementTab } from '@/components/MeasurementTab';
import { PortfolioTab } from '@/components/PortfolioTab';
import { VerdictsTab } from '@/components/VerdictsTab';
import { ResetButton } from '@/components/ResetButton';
import { ClusterBuyers } from '@/components/ClusterBuyers';
import { FundamentalsCard } from '@/components/FundamentalsCard';
import { TrackRecordCard } from '@/components/TrackRecordCard';
import { CouncilDetails } from '@/components/CouncilDetails';

/** Rang-baseret auto-kø fra scan-svaret (server-side regel, se src/lib/auto-queue.ts). */
interface AutoQueue {
  rule: string;
  topN: number;
  minScore: number;
  ids: string[];
}

interface ScanResponse {
  success: boolean;
  source: string;
  ticker?: string | null;
  apiKeysConfigured: {
    gemini: boolean;
    anthropic: boolean;
    gatekeeperProvider?: 'claude' | 'gemini';
    gatekeeperModel?: string;
  };
  count: number;
  items: ScanItem[];
  gatekeeperUsage?: GatekeeperUsage | null;
  scannedAt?: string | null;
  saved?: boolean; // true = ?latest=1: seneste gemte scan, ingen ny scan kørt
  ledger?: { inserted: number; seen: number; scored: number } | { error: string } | null;
  autoQueue?: AutoQueue;
  stale?: boolean; // true = live-hentning fejlede, items er den seneste gemte scan
  errors?: Array<{ source: string; error: string }>;
  rejectedCount?: number;
  rejected?: RejectedRow[];
  error?: string;
}

const STORAGE_KEY = 'insiderops_verdicts_v1';
const CAPITAL_STORAGE_KEY = 'insiderops_capital_frame_dkk';
const TRANCHES_STORAGE_KEY = 'insiderops_use_tranches';
// Samme fil som serveren bruger (costs.ts); kun til visning af forventede omkostninger i handelsplanen.
const COSTS = costsJson as CostsConfig;
export default function Dashboard() {
  const source = 'unified' as const; // UI'et vælger ikke kilde; ?source= findes stadig i API'et
  const [regionFilter, setRegionFilter] = useState<'all' | 'us' | 'nordic'>('all');
  const [quickFilter, setQuickFilter] = useState<
    'all' | 'ceo_cfo' | 'csuite' | 'cluster_discount' | 'below_insider' | 'csuite_cluster'
  >('all');
  const [searchTicker, setSearchTicker] = useState<string>('');
  const [activeTickerQuery, setActiveTickerQuery] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'radar' | 'watchlist' | 'portfolio' | 'maaling'>('radar');

  const [showRejected, setShowRejected] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  // Rådsfejl vises for brugeren – der findes ingen simuleret eller fallback-dom.
  const [councilError, setCouncilError] = useState<string | null>(null);
  // Fejl ved oprettelse/lukning af en position vises i siden (tidligere alert()).
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [items, setItems] = useState<ScanItem[]>([]);
  // Rækker afvist allerede i scan-pipelinen (kode, beløb, handelbarhed, Norden) – de er ikke i items.
  const [scanRejected, setScanRejected] = useState<RejectedRow[]>([]);
  const [apiKeys, setApiKeys] = useState<ScanResponse['apiKeysConfigured']>({
    gemini: false,
    anthropic: false,
  });
  const [gatekeeperUsage, setGatekeeperUsage] = useState<GatekeeperUsage | null>(null);
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [autoQueue, setAutoQueue] = useState<AutoQueue | null>(null);

  // Paper-Trading Portfolio State
  const [paperPortfolio, setPaperPortfolio] = useState<Record<string, PaperTradePosition>>({});
  // Én opsummering pr. handelstype – PAPER og REAL_NORDNET blandes aldrig i KPI'erne.
  const [portfolioSummaries, setPortfolioSummaries] = useState<Partial<Record<TradeType, PortfolioSummary>>>({});
  const [realKpis, setRealKpis] = useState<RealKpis | null>(null);
  // Senest gemte valutakurser fra /api/portfolio – uden dem laver trade-planneren ingen plan (ingen hårdkodede kurser).
  const [fxRates, setFxRates] = useState<LiveFxRates | null>(null);
  const [portfolioRefreshedAt, setPortfolioRefreshedAt] = useState<string | null>(null);
  const [portfolioLoading, setPortfolioLoading] = useState<boolean>(false);
  const [portfolioRefreshing, setPortfolioRefreshing] = useState<boolean>(false);

  // Inline Position Editing State (Nordnet Match)
  const [editingPosId, setEditingPosId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    tradeType: 'PAPER' | 'REAL_NORDNET';
    entryPrice: number;
    shares: number;
    stopLossPrice: number;
    targetPrice: number;
  }>({
    tradeType: 'PAPER',
    entryPrice: 0,
    shares: 0,
    stopLossPrice: 0,
    targetPrice: 0,
  });
  const [isSavingEdit, setIsSavingEdit] = useState<boolean>(false);

  // The Council & Persistent Watchlist State
  const [selectedTx, setSelectedTx] = useState<InsiderTransaction | null>(null);
  const [councilLoading, setCouncilLoading] = useState<boolean>(false);
  const [activeVerdict, setActiveVerdict] = useState<CouncilVerdict | null>(null);
  const [verdictHistory, setVerdictHistory] = useState<Record<string, SavedVerdictItem>>({});
  const [showContextNotes, setShowContextNotes] = useState<boolean>(true);
  const [judgeTier, setJudgeTier] = useState<'opus' | 'sonnet'>('opus');
  const [showThinking, setShowThinking] = useState<boolean>(true);
  const [memoCopied, setMemoCopied] = useState<boolean>(false);
  const [maxCapitalDkk, setMaxCapitalDkk] = useState<number>(25000);
  const [useTranches, setUseTranches] = useState(false); // én ordre som standard; to trancher fordobler købskurtagen
  const planOpts = { tranches: useTranches, costs: COSTS };
  const [councilQueueRunning, setCouncilQueueRunning] = useState<boolean>(false);
  const [councilQueueProgress, setCouncilQueueProgress] = useState<{
    current: number;
    total: number;
    ticker: string;
    label?: string;
  } | null>(null);
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [recommendationFilterTab, setRecommendationFilterTab] = useState<'BUY' | 'WATCH' | 'REJECTED'>('BUY');
  // Backward compatibility alias for any autoPilot references
  const autoPilotRunning = councilQueueRunning;

  const memoCtx = { maxCapitalDkk, fxRates, planOpts };
  const generateInvestmentMemoMarkdown = (tx: InsiderTransaction, verdict: CouncilVerdict) => buildMemo(tx, verdict, memoCtx);

  // "Nulstil data": serveren tager backup og sletter domme og paper-positioner. Browserens cache af domme og
  // indstillinger ryddes, og siden genindlæses, så al state starter forfra.
  const handleResetData = async () => {
    const res = await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'NULSTIL' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    try {
      [STORAGE_KEY, CAPITAL_STORAGE_KEY, TRANCHES_STORAGE_KEY].forEach((k) => localStorage.removeItem(k));
    } catch {
      // ignore
    }
    window.location.reload();
  };

  const handleCopyMemo = () => {
    if (!selectedTx || !activeVerdict) return;
    const memo = generateInvestmentMemoMarkdown(selectedTx, activeVerdict);
    navigator.clipboard.writeText(memo);
    setMemoCopied(true);
    setTimeout(() => setMemoCopied(false), 2500);
  };

  const handleDownloadMemo = () => {
    if (!selectedTx || !activeVerdict) return;
    const memo = generateInvestmentMemoMarkdown(selectedTx, activeVerdict);
    const blob = new Blob([memo], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `InsiderOps_${selectedTx.ticker}_${selectedTx.tradeDate || 'memo'}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Indlæs gemte domme fra localStorage og synkroniser med serverens persistente database
  useEffect(() => {
    // Samme regel som isMockEntity i db.ts: kun id-præfikset "mock-", aldrig ticker.
    const isMock = (id: string) => id.startsWith('mock-');

    // localStorage læses her (ikke i useState), så server- og klient-HTML er ens ved hydrering. Værdierne sættes
    // samlet, når /api/council har svaret – én render i stedet for to, og intet setState synkront i effekten.
    let cachedVerdicts: Record<string, SavedVerdictItem> = {};
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) cachedVerdicts = JSON.parse(stored) as Record<string, SavedVerdictItem>;
    } catch (e) {
      console.warn('Kunne ikke hente gemt historik fra localStorage:', e);
    }
    let cachedCap: number | null = null;
    let cachedTranches = false;
    try {
      const val = parseInt(localStorage.getItem(CAPITAL_STORAGE_KEY) ?? '', 10);
      if ([10000, 25000, 50000, 100000].includes(val)) cachedCap = val;
      cachedTranches = localStorage.getItem(TRANCHES_STORAGE_KEY) === '1';
    } catch {
      // ignore
    }

    // Synkroniser med den persistente server-side database (/api/council)
    fetch('/api/council')
      .then((res) => (res.ok ? res.json() : null))
      .catch((err) => {
        console.warn('Kunne ikke synkronisere med server-database:', err);
        return null;
      })
      .then((data) => {
        // Serveren er sandheden (fx efter migration); localStorage er kun cache.
        const merged = { ...cachedVerdicts, ...(data?.verdicts ?? {}) };
        const cleaned: Record<string, SavedVerdictItem> = {};
        for (const [k, v] of Object.entries(merged as Record<string, SavedVerdictItem>)) {
          if (!isMock(k)) {
            cleaned[k] = v;
          }
        }
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
        } catch {
          // ignore
        }
        setVerdictHistory(cleaned);
        if (cachedCap !== null) setMaxCapitalDkk(cachedCap);
        setUseTranches(cachedTranches);
      });

    // Kun gemte positioner og valutakurser – ingen eksterne kald uden klik. Live kurser: knappen "Opdatér".
    fetch('/api/portfolio', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.positions) {
          setPortfolioRefreshedAt(data.refreshedAt ?? null);
          const map: Record<string, PaperTradePosition> = {};
          data.positions.forEach((p: PaperTradePosition) => {
            if (!isMock(p.id)) {
              map[p.id] = p;
            }
          });
          setPaperPortfolio(map);
          if (data.summaries) setPortfolioSummaries(data.summaries);
        if (data.realKpis) setRealKpis(data.realKpis);
          if (data.fxRates) setFxRates(data.fxRates);
        }
      })
      .catch((err) => console.warn('Kunne ikke hente paper-trading portefølje:', err));
  }, []);

  const loadScan = useCallback(
    (
      selectedSource: 'unified' | 'csuite' | 'live' | 'nordic' | 'mock',
      tickerQuery?: string | null,
      opts: { latest?: boolean } = {}
    ) => {
      const url =
        (tickerQuery ? `/api/scan?ticker=${encodeURIComponent(tickerQuery)}` : `/api/scan?source=${selectedSource}`) +
        (opts.latest ? '&latest=1' : '');

      // Promise-kæde frem for try/await: al setState sker i callbacks (react-hooks/set-state-in-effect).
      return fetch(url)
        .then(async (res) => {
          const data: ScanResponse = await res.json().catch(() => ({}) as ScanResponse);
          if (!res.ok) throw new Error(data.error || `HTTP-fejl ${res.status}`);
          return data;
        })
        .then((data) => {
          setItems(data.items || []);
          setScanRejected(data.rejected ?? []);
          setApiKeys(data.apiKeysConfigured || { gemini: false, anthropic: false });
          setGatekeeperUsage(data.gatekeeperUsage ?? null);
          setScannedAt(data.scannedAt ?? null);
          setAutoQueue(data.autoQueue ?? null);

          // Fejl og forældede data vises som det, de er – aldrig som "ingen signaler".
          const notes: string[] = [];
          if (data.saved && !data.scannedAt) {
            notes.push('Ingen gemt scan for denne kilde endnu – tryk "Scan Nu" for at hente signaler.');
          }
          if (data.ledger && 'error' in data.ledger) {
            notes.push(`Signal-ledgeren blev IKKE opdateret: ${data.ledger.error}`);
          }
          if (data.stale) {
            notes.push(`Viser gemt scan fra ${formatDateTimeDk(data.scannedAt ?? undefined)} – live-hentningen fejlede (forældede data).`);
          }
          if (data.errors?.length) {
            notes.push(`Kilder der fejlede: ${data.errors.map((e) => `${e.source}: ${e.error}`).join(' • ')}`);
          }
          if (!data.stale && !data.saved && data.items.length === 0) {
            notes.push(
              tickerQuery
                ? `Ingen åbne markedskøb (kode P) hos SEC for '${tickerQuery}', der består filtrene (${data.rejectedCount ?? 0} afvist).`
                : `Ingen rækker bestod filtrene (${data.rejectedCount ?? 0} afvist).`
            );
          }
          if (notes.length > 0) setError(notes.join('\n'));
        })
        .catch((err: unknown) => {
          console.error(err);
          setError(`Scanningen fejlede: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => setLoading(false));
    },
    []
  );

  /** Til handlere: viser "henter" og rydder fejl, før scannen hentes. */
  const fetchScan = (...args: Parameters<typeof loadScan>) => {
    setLoading(true);
    setError(null);
    return loadScan(...args);
  };

  // Indlæsning (og hot-reload) viser seneste gemte scan – en ny scan kører kun ved "Scan Nu" (fase 3).
  // Søgning og nulstilling kalder selv fetchScan, så effekten afhænger ikke af activeTickerQuery
  // (før gav "Scan Nu" efter en tickersøgning to samtidige hentninger).
  useEffect(() => {
    loadScan(source, null, { latest: true });
  }, [loadScan, source]);

  const handleTickerSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = searchTicker.trim().toUpperCase();
    if (!clean) return;

    setActiveTickerQuery(clean);
    setActiveTab('radar');
    fetchScan(source, clean);
  };

  const handleResetSearch = () => {
    setSearchTicker('');
    setActiveTickerQuery(null);
    fetchScan(source, null, { latest: true });
  };

  const handleToggleTranches = (on: boolean) => {
    setUseTranches(on);
    try {
      localStorage.setItem(TRANCHES_STORAGE_KEY, on ? '1' : '0');
    } catch {
      // ignore
    }
  };

  const handleSelectCapitalFrame = (amt: number) => {
    setMaxCapitalDkk(amt);
    try {
      localStorage.setItem(CAPITAL_STORAGE_KEY, amt.toString());
    } catch {
      // ignore
    }
  };

  const readCouncilError = async (res: Response): Promise<string> => {
    try {
      const data = await res.json();
      return data?.error || `HTTP ${res.status}`;
    } catch {
      return `HTTP ${res.status}`;
    }
  };

  const handleConveneCouncil = async (
    tx: InsiderTransaction,
    forceRefresh: boolean = false,
    tierOverride?: 'opus' | 'sonnet'
  ) => {
    setSelectedTx(tx);
    const targetTier = tierOverride || judgeTier;

    // Tjek om vi allerede har afsagt dom med den valgte tier (0 token-forbrug)
    const existing = verdictHistory[tx.id];
    if (
      !forceRefresh &&
      existing &&
      (!existing.verdict.modelsUsed?.judgeTier || existing.verdict.modelsUsed.judgeTier === targetTier)
    ) {
      if (existing.transaction) setSelectedTx(existing.transaction);
      setActiveVerdict(existing.verdict);
      return;
    }

    setCouncilLoading(true);
    setActiveVerdict(null);
    setCouncilError(null);

    try {
      const res = await fetch('/api/council', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Kun id: serveren henter transaktionen fra den gemte scan/dom og stoler ikke på klientens data.
        body: JSON.stringify({ id: tx.id, judgeTier: targetTier, forceRefresh }),
      });
      if (!res.ok) throw new Error(await readCouncilError(res));
      const data = await res.json();
      if (data.verdict) {
        const enrichedTx = data.transaction || tx;
        setSelectedTx(enrichedTx);
        const newRecord: SavedVerdictItem = {
          transaction: enrichedTx,
          verdict: data.verdict,
          savedAt: new Date().toISOString(),
        };

        const updatedHistory = { ...verdictHistory, [tx.id]: newRecord };
        setActiveVerdict(data.verdict);
        setVerdictHistory(updatedHistory);

        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedHistory));
        } catch (storageErr) {
          console.warn('Kunne ikke gemme dom i localStorage:', storageErr);
        }
      }
    } catch (err) {
      console.error(err);
      setCouncilError(
        `Rådet fejlede for ${tx.ticker} – ingen dom er afsagt eller gemt. ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setCouncilLoading(false);
    }
  };

  const handleRemoveFromWatchlist = async (txId: string) => {
    const updated = { ...verdictHistory };
    delete updated[txId];
    setVerdictHistory(updated);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch (err) {
      console.warn(err);
    }
    try {
      await fetch(`/api/council?id=${encodeURIComponent(txId)}`, { method: 'DELETE' });
    } catch (err) {
      console.warn('Kunne ikke slette dom på serveren:', err);
    }
    if (selectedTx?.id === txId) {
      setActiveVerdict(null);
      setSelectedTx(null);
    }
  };

  const [refreshingAlpha, setRefreshingAlpha] = useState<boolean>(false);

  const handleRefreshWatchlistAlpha = async () => {
    const records = Object.values(verdictHistory);
    if (records.length === 0) return;
    setRefreshingAlpha(true);
    try {
      const txs = records.map((item) => item.transaction);
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: txs }),
      });
      if (!res.ok) throw new Error('Kunne ikke hente live kurser');
      const data = await res.json();
      if (data.transactions && Array.isArray(data.transactions)) {
        const updatedHistory = { ...verdictHistory };
        for (const updatedTx of data.transactions) {
          if (updatedHistory[updatedTx.id]) {
            updatedHistory[updatedTx.id] = {
              ...updatedHistory[updatedTx.id],
              transaction: updatedTx,
            };
          }
        }
        setVerdictHistory(updatedHistory);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedHistory));
      }
    } catch (err) {
      console.error('Fejl ved opdatering af live alpha:', err);
    } finally {
      setRefreshingAlpha(false);
    }
  };

  const handleOpenPaperTrade = async (
    tx: InsiderTransaction,
    plan: ReturnType<typeof generateTradeExecutionPlan>,
    scoreOverride?: number
  ) => {
    if (plan.status !== 'ACTIVE_PLAN' || plan.recommendedAllocationDkk <= 0) return;
    setPortfolioLoading(true);
    setPortfolioError(null);
    try {
      const posPayload = {
        id: tx.id,
        ticker: tx.ticker,
        companyName: tx.companyName,
        exchange: tx.exchange,
        insiderName: tx.insiderName,
        insiderTitle: tx.insiderTitle,
        // Ingen standardscore: uden en afsagt dom afviser serveren positionen.
        asymmetryScore: scoreOverride ?? activeVerdict?.asymmetryScore,
        insiderBuyPrice: tx.pricePerShare,
        // Entry-kursen låses server-side til en verificeret live kurs.
        shares: plan.totalShares,
        investedDkk: plan.recommendedAllocationDkk,
        stopLossPrice: plan.stopLossPrice,
        targetPrice: plan.targetPrice1,
      };
      const res = await fetch('/api/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(posPayload),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.position) {
        setPaperPortfolio((prev) => ({ ...prev, [data.position.id]: data.position }));
        if (data.summaries) setPortfolioSummaries(data.summaries);
        if (data.realKpis) setRealKpis(data.realKpis);
        if (data.fxRates) setFxRates(data.fxRates);
      } else {
        setPortfolioError(`Positionen blev ikke oprettet: ${data.error || `HTTP ${res.status}`}`);
      }
    } catch (e) {
      console.error('Fejl ved oprettelse af paper-trade:', e);
      setPortfolioError(`Positionen blev ikke oprettet: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPortfolioLoading(false);
    }
  };

  const handleRefreshPortfolioLivePnl = async () => {
    setPortfolioRefreshing(true);
    try {
      const res = await fetch(`/api/portfolio?refresh=true&_t=${Date.now()}`);
      if (res.ok) {
        const data = await res.json();
        if (data.positions) {
          setPortfolioRefreshedAt(data.refreshedAt ?? null);
          const map: Record<string, PaperTradePosition> = {};
          data.positions.forEach((p: PaperTradePosition) => {
            map[p.id] = p;
          });
          setPaperPortfolio(map);
          if (data.summaries) setPortfolioSummaries(data.summaries);
        if (data.realKpis) setRealKpis(data.realKpis);
          if (data.fxRates) setFxRates(data.fxRates);
        }
      }
    } catch (err) {
      console.warn('Fejl ved opdatering af portefølje live P&L:', err);
    } finally {
      setPortfolioRefreshing(false);
    }
  };

  // Lukning sletter ikke: positionen får CLOSED_MANUAL med exit-kurs, exit-FX og realiseret P&L.
  const handleClosePaperTrade = async (id: string) => {
    setPortfolioError(null);
    try {
      const res = await fetch('/api/portfolio', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'close' }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.position) {
        setPaperPortfolio((prev) => ({ ...prev, [id]: data.position }));
        if (data.summaries) setPortfolioSummaries(data.summaries);
        if (data.realKpis) setRealKpis(data.realKpis);
        if (data.fxRates) setFxRates(data.fxRates);
      } else {
        setPortfolioError(`Positionen blev ikke lukket: ${data.error || `HTTP ${res.status}`}`);
      }
    } catch (e) {
      console.error('Fejl ved lukning af paper-trade position:', e);
      setPortfolioError(`Positionen blev ikke lukket: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleStartEdit = (pos: PaperTradePosition) => {
    setEditingPosId(pos.id);
    setEditForm({
      tradeType: pos.tradeType || 'PAPER',
      entryPrice: pos.entryPrice,
      shares: pos.shares,
      stopLossPrice: pos.stopLossPrice || 0,
      targetPrice: pos.targetPrice || 0,
    });
  };

  const handleSaveEdit = async (id: string) => {
    setIsSavingEdit(true);
    try {
      const res = await fetch('/api/portfolio', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          tradeType: editForm.tradeType,
          entryPrice: Number(editForm.entryPrice),
          shares: Number(editForm.shares),
          stopLossPrice: Number(editForm.stopLossPrice),
          targetPrice: Number(editForm.targetPrice),
        }),
      });
      const data = await res.json();
      if (data.success && data.positions) {
        const map: Record<string, PaperTradePosition> = {};
        data.positions.forEach((p: PaperTradePosition) => {
          map[p.id] = p;
        });
        setPaperPortfolio(map);
        if (data.summaries) setPortfolioSummaries(data.summaries);
        if (data.realKpis) setRealKpis(data.realKpis);
          if (data.fxRates) setFxRates(data.fxRates);
        setEditingPosId(null);
      }
    } catch (err) {
      console.error('Fejl ved opdatering af position:', err);
    } finally {
      setIsSavingEdit(false);
    }
  };

  // 1. Auto-kø (fase 3): de N højest Claude-scorede rækker pr. scan med score ≥ min og uden gemt dom.
  //    Reglen beregnes server-side (AUTO_QUEUE_TOP_N / AUTO_QUEUE_MIN_SCORE); rådet starter kun ved klik.
  const unjudgedHighItems = items.filter(
    (item) => autoQueue?.ids.includes(item.transaction.id) && !verdictHistory[item.transaction.id]
  );
  const unjudgedHighCount = unjudgedHighItems.length;

  // 2. Rådskø: kører rådet på transaktionerne én ad gangen og gemmer hver dom. Fælles for "Send til rådet"
  //    (valgte rækker) og auto-køen; de adskiller sig kun i queueRule, forceRefresh og tekst.
  const runCouncilQueue = async (
    txs: InsiderTransaction[],
    opts: { queueRule?: string; refreshJudged: boolean; labelPrefix: string; logLabel: string; onDone?: () => void }
  ) => {
    setCouncilQueueRunning(true);
    setActiveTab('radar');
    let currentHistory = { ...verdictHistory };
    const completed: Array<{ tx: InsiderTransaction; verdict: CouncilVerdict }> = [];
    const failures: string[] = [];
    setCouncilError(null);

    try {
      for (let i = 0; i < txs.length; i++) {
        const tx = txs[i];
        setCouncilQueueProgress({
          current: i + 1,
          total: txs.length,
          ticker: tx.ticker,
          label: `${opts.labelPrefix}${tx.ticker} (${i + 1}/${txs.length})...`,
        });

        const res = await fetch('/api/council', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: tx.id,
            judgeTier,
            // Valgte rækker med en gammel dom gen-vurderes med frisk kurs; auto-køen har kun rækker uden dom.
            forceRefresh: opts.refreshJudged && Boolean(currentHistory[tx.id]),
            queueRule: opts.queueRule, // logges i signal-ledgeren
          }),
        });

        if (res.ok) {
          const data = await res.json();
          if (data.verdict) {
            const enrichedTx = data.transaction || tx;
            const newRecord: SavedVerdictItem = {
              transaction: enrichedTx,
              verdict: data.verdict,
              savedAt: new Date().toISOString(),
            };
            currentHistory = { ...currentHistory, [tx.id]: newRecord };
            setVerdictHistory(currentHistory);
            try {
              localStorage.setItem(STORAGE_KEY, JSON.stringify(currentHistory));
            } catch (storageErr) {
              console.warn(storageErr);
            }
            completed.push({ tx: enrichedTx, verdict: data.verdict });
          }
        } else {
          failures.push(`${tx.ticker}: ${await readCouncilError(res)}`);
        }
      }

      if (failures.length > 0) {
        setCouncilError(`${failures.length} råd fejlede – ingen dom gemt for dem. ${failures.join(' · ')}`);
      }

      if (completed.length > 0) {
        completed.sort((a, b) => b.verdict.asymmetryScore - a.verdict.asymmetryScore);
        const best = completed[0];
        setSelectedTx(best.tx);
        setActiveVerdict(best.verdict);
      }
      opts.onDone?.();
    } catch (err) {
      console.error(`Fejl under afvikling af ${opts.logLabel}:`, err);
    } finally {
      setCouncilQueueRunning(false);
      setCouncilQueueProgress(null);
    }
  };

  // Valgte rækker (multi-select): findes rækken ikke i scannen, bruges den gemte doms transaktion.
  const handleRunCouncilOnSelected = async () => {
    if (councilQueueRunning || loading || selectedRowIds.length === 0) return;

    const selectedTransactions: InsiderTransaction[] = [];
    for (const id of selectedRowIds) {
      const foundInItems = items.find((i) => i.transaction.id === id)?.transaction;
      if (foundInItems) {
        selectedTransactions.push(foundInItems);
      } else if (verdictHistory[id]?.transaction) {
        selectedTransactions.push(verdictHistory[id].transaction);
      }
    }
    if (selectedTransactions.length === 0) return;

    await runCouncilQueue(selectedTransactions, {
      queueRule: 'manuel',
      refreshJudged: true,
      labelPrefix: 'Analyserer ',
      logLabel: 'rådskø',
      onDone: () => setSelectedRowIds([]),
    });
  };

  // 3. Auto-kø: alle uvurderede rækker, som rangreglen har udvalgt.
  const handleAnalyzeAllUnjudgedHigh = async () => {
    if (councilQueueRunning || loading || unjudgedHighCount === 0) return;
    await runCouncilQueue(
      unjudgedHighItems.map((item) => item.transaction),
      { queueRule: autoQueue?.rule, refreshJudged: false, labelPrefix: 'Auto-kø: analyserer ', logLabel: 'auto-køen' }
    );
  };

  // KPI Beregninger
  const totalScanned = items.length;
  // Alle afviste: pipelinens rejected-liste + items, der ikke bestod hard-filteret (ældre gemte scans).
  const rejectedRows = collectRejected(scanRejected, items);
  const savedVerdictItems = Object.values(verdictHistory).sort(
    (a, b) => b.verdict.asymmetryScore - a.verdict.asymmetryScore
  );
  const councilsConvenedCount = savedVerdictItems.length;

  // Top Picks: kun skema-validerede domme med verificeret handelbarhed og kendte fundamentals.
  // Ældre domme (uden validated) eller UNKNOWN-data vises ikke her, før de er vurderet igen.
  const isTopPickEligible = (i: SavedVerdictItem) =>
    i.verdict.validated === true &&
    i.transaction.isTradableInDK === true &&
    !!i.transaction.fundamentals &&
    i.transaction.fundamentals.fundamentalHealthBadge !== 'UNKNOWN';
  const buyRecommendations = savedVerdictItems.filter(
    (i) =>
      isTopPickEligible(i) &&
      (i.verdict.asymmetryScore >= 75 || i.verdict.verdict === 'STRONG ASYMMETRY (KØB)')
  );
  const watchRecommendations = savedVerdictItems.filter(
    (i) =>
      (i.verdict.asymmetryScore >= 60 && i.verdict.asymmetryScore < 75) ||
      i.verdict.verdict === 'MODERATE SIGNAL (OVERVÅG)'
  );
  const rejectedRecommendations = savedVerdictItems.filter(
    (i) => i.verdict.asymmetryScore < 60 || i.verdict.verdict === 'PR STUNT / STØJ (IGNORER)'
  );

  const strongBuyItems = savedVerdictItems.filter(
    (i) =>
      i.verdict.verdict === 'STRONG ASYMMETRY (KØB)' &&
      i.transaction.returnSinceBuyPct !== undefined
  );
  const avgStrongAlpha =
    strongBuyItems.length > 0
      ? (
          strongBuyItems.reduce(
            (acc, i) => acc + (i.transaction.returnSinceBuyPct || 0),
            0
          ) / strongBuyItems.length
        ).toFixed(2)
      : null;

  const isNordicTx = (tx: InsiderTransaction) => {
    const t = (tx.ticker || '').toUpperCase();
    const ex = (tx.exchange || '').toUpperCase();
    return (
      t.endsWith('.CO') ||
      t.endsWith('.ST') ||
      t.endsWith('.HE') ||
      t.endsWith('.OL') ||
      ex.includes('COPENHAGEN') ||
      ex.includes('STOCKHOLM') ||
      ex.includes('HELSINKI') ||
      ex.includes('FIRST NORTH') ||
      ex.includes('CPH') ||
      ex.includes('STO') ||
      ex.includes('HEL')
    );
  };

  // Rabat-zonen kræver kendt afkast og verificeret handelbarhed – ukendt tælles ikke som rabat.
  const isBelowInsiderZone = (i: ScanItem) =>
    i.result.passedHardFilter &&
    i.transaction.isTradableInDK === true &&
    i.transaction.returnSinceBuyPct !== undefined &&
    i.transaction.returnSinceBuyPct <= 0.5;

  // Afviste rækker vises i panelet "Vis afvist støj", ikke i tabellen.
  const baseFiltered = items.filter((i) => i.result.passedHardFilter);

  const filteredItems = baseFiltered.filter((i) => {
    // 1. Regions-filter (Client-side)
    if (regionFilter === 'us' && isNordicTx(i.transaction)) return false;
    if (regionFilter === 'nordic' && !isNordicTx(i.transaction)) return false;

    // 2. Hurtig-filter
    if (quickFilter === 'ceo_cfo') return isCeoCfoBuy(i.transaction);
    if (quickFilter === 'csuite') {
      return i.transaction.isExecutiveOfficer === true;
    }
    if (quickFilter === 'cluster_discount') {
      return Boolean(
        i.transaction.isClusterBuy || i.transaction.isTradingBelowInsiderPrice
      );
    }
    if (quickFilter === 'below_insider') return isBelowInsiderZone(i);
    if (quickFilter === 'csuite_cluster') {
      return (
        i.result.passedHardFilter &&
        (i.transaction.isExecutiveOfficer === true || (i.transaction.clusterCount ?? 1) >= 2) &&
        (i.transaction.totalValueUsd ?? 0) >= 100000
      );
    }
    return true;
  });

  const ceoCfoCount = baseFiltered.filter((i) => isCeoCfoBuy(i.transaction)).length;
  const cSuiteCount = baseFiltered.filter((i) => i.transaction.isExecutiveOfficer === true).length;
  const clusterDiscountCount = baseFiltered.filter((i) =>
    Boolean(i.transaction.isClusterBuy || i.transaction.isTradingBelowInsiderPrice)
  ).length;
  const belowInsiderCount = baseFiltered.filter(isBelowInsiderZone).length;
  const csuiteClusterCount = baseFiltered.filter(
    (i) =>
      i.result.passedHardFilter &&
      (i.transaction.isExecutiveOfficer === true || (i.transaction.clusterCount ?? 1) >= 2) &&
      (i.transaction.totalValueUsd ?? 0) >= 100000
  ).length;

  const usCount = baseFiltered.filter((i) => !isNordicTx(i.transaction)).length;
  const nordicCount = baseFiltered.filter((i) => isNordicTx(i.transaction)).length;

  const tabs: NavTab<typeof activeTab>[] = [
    { id: 'radar', label: 'Radar', icon: Activity, count: filteredItems.length },
    { id: 'watchlist', label: 'Domme', icon: Bookmark, count: savedVerdictItems.length },
    { id: 'portfolio', label: 'Portefølje', icon: Briefcase, count: Object.keys(paperPortfolio).length },
    { id: 'maaling', label: 'Måling', icon: Ruler },
  ];
  const gatekeeperKeySet = apiKeys.gatekeeperProvider === 'gemini' ? apiKeys.gemini : apiKeys.anthropic;
  const selectedScan = selectedTx ? items.find((i) => i.transaction.id === selectedTx.id) : undefined;
  const plan = selectedTx && activeVerdict ? generateTradeExecutionPlan(selectedTx, activeVerdict, maxCapitalDkk, fxRates, planOpts) : null;

  const errorNote = (message: string | null, clear: () => void) =>
    message && (
      <div role="alert" className="flex items-start gap-2 rounded-md border border-loss/50 bg-surface p-3 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-loss" aria-hidden />
        <span className="flex-1">{message}</span>
        <button type="button" onClick={clear} className="text-graphite hover:text-ink" aria-label="Luk fejlbesked">
          <X className="size-4" />
        </button>
      </div>
    );
  const councilErrorNote = errorNote(councilError, () => setCouncilError(null));
  const portfolioErrorNote = errorNote(portfolioError, () => setPortfolioError(null));

  return (
    <AppShell
      tabs={tabs}
      active={activeTab}
      onTab={setActiveTab}
      footer={
        <>
          <p title={gatekeeperUsage ? `${gatekeeperUsage.inputTokens} input · ${gatekeeperUsage.cacheCreationInputTokens} cache-skriv · ${gatekeeperUsage.cacheReadInputTokens} cache-læs · ${gatekeeperUsage.outputTokens} output tokens · ${gatekeeperUsage.heuristicCount} heuristik · ${gatekeeperUsage.truncatedChunks} afskåret` : undefined}>
            Gatekeeper{apiKeys.gatekeeperModel ? ` (${apiKeys.gatekeeperModel})` : ''}: {gatekeeperKeySet ? 'nøgle sat' : 'ingen nøgle – heuristik'}
            {gatekeeperUsage && gatekeeperUsage.calls > 0 && (
              <>
                {' '}
                · <span className="font-mono">{gatekeeperUsage.calls}</span> kald ·{' '}
                <span className="font-mono">{gatekeeperUsage.costUsd !== undefined ? `$${gatekeeperUsage.costUsd.toFixed(4)}` : 'pris ukendt'}</span>
              </>
            )}
          </p>
          <p>Claude Sonnet + Opus: {apiKeys.anthropic ? 'nøgle sat' : 'ingen nøgle – rådet fejler'}</p>
          <p>Samlet scanner: USA (SEC) + direktion + Norden (MAR 19)</p>
          <div className="mt-3">
            <ResetButton onReset={handleResetData} />
          </div>
        </>
      }
      caseOpen={!!selectedTx}
      caseTitle={selectedTx?.ticker ?? ''}
      onCloseCase={() => {
        setActiveVerdict(null);
        setSelectedTx(null);
      }}
      caseContent={
        selectedTx && (
          <>
            {councilErrorNote}
            <CasePanel
              tx={selectedTx}
              verdict={councilLoading ? null : activeVerdict}
              preScore={
                selectedScan && { score: selectedScan.result.geminiPreScore, model: isModelScore(selectedScan.result), reasoning: selectedScan.result.quickReasoning }
              }
              loading={councilLoading}
              costs={COSTS}
              planCost={plan?.status === 'ACTIVE_PLAN' ? plan.cost : undefined}
              judgeTier={judgeTier}
              onJudgeTier={(tier) => {
                setJudgeTier(tier);
                if (selectedTx && activeVerdict?.modelsUsed?.judgeTier !== tier) {
                  handleConveneCouncil(selectedTx, true, tier);
                }
              }}
              onConvene={() => handleConveneCouncil(selectedTx, false)}
              onReevaluate={() => handleConveneCouncil(selectedTx, true)}
              onCopyMemo={handleCopyMemo}
              onDownloadMemo={handleDownloadMemo}
              memoCopied={memoCopied}
            >
              {!councilLoading && activeVerdict && plan && (
                <>
                  <FundamentalsCard fundamentals={selectedTx.fundamentals || verdictHistory[selectedTx.id]?.transaction.fundamentals} />
                  <ClusterBuyers tx={selectedTx} />
                  <TrackRecordCard tx={selectedTx} />
                  <TradePlanCard
                    tx={selectedTx}
                    plan={plan}
                    currSym={curLabel(currencyForTicker(selectedTx.ticker))}
                    maxCapitalDkk={maxCapitalDkk}
                    onCapital={handleSelectCapitalFrame}
                    useTranches={useTranches}
                    onTranches={handleToggleTranches}
                    fxUpdatedAt={fxRates?.lastUpdated}
                    position={paperPortfolio[selectedTx.id]}
                    portfolioLoading={portfolioLoading}
                    onOpenPaperTrade={() => handleOpenPaperTrade(selectedTx, plan)}
                    holdNote={HOLD_NOTE}
                  />
                  {portfolioErrorNote}
                  <CouncilDetails
                    verdict={activeVerdict}
                    contextNotes={selectedTx.contextNotes}
                    showThinking={showThinking}
                    onToggleThinking={() => setShowThinking(!showThinking)}
                    showContextNotes={showContextNotes}
                    onToggleContextNotes={() => setShowContextNotes(!showContextNotes)}
                  />
                </>
              )}
            </CasePanel>
          </>
        )
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-loss/50 bg-surface p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-loss" aria-hidden />
            <span className="whitespace-pre-line">{error}</span>
          </div>
        )}
        {councilErrorNote}
        {portfolioErrorNote}
        {councilQueueRunning && councilQueueProgress && (
          <div role="status" className="flex items-center gap-2 rounded-md border border-line bg-surface p-3 text-sm">
            <Loader2 className="size-4 shrink-0 animate-spin text-accent" aria-hidden />
            <span>
              <span className="font-medium">Rådskø kører: </span>
              {councilQueueProgress.label ||
                `Rådet vurderer ${councilQueueProgress.ticker} (${councilQueueProgress.current} af ${councilQueueProgress.total} kandidater) …`}
            </span>
          </div>
        )}
      </div>

      <div className={error || councilError || portfolioError || councilQueueRunning ? 'mt-5' : ''}>
        {activeTab === 'radar' && (
          <RadarTab
            loading={loading}
            scannedAt={scannedAt}
            activeTickerQuery={activeTickerQuery}
            onScan={() => {
              setActiveTickerQuery(null);
              fetchScan('unified', null);
            }}
            searchTicker={searchTicker}
            onSearchTicker={setSearchTicker}
            onTickerSearch={handleTickerSearch}
            onResetSearch={handleResetSearch}
            stats={{ scanned: totalScanned, rejected: rejectedRows, autoQueueCount: unjudgedHighCount, savedVerdicts: councilsConvenedCount }}
            showRejected={showRejected}
            onToggleRejected={() => setShowRejected(!showRejected)}
            checkedIds={selectedRowIds}
            setCheckedIds={setSelectedRowIds}
            onSendSelected={handleRunCouncilOnSelected}
            queueRunning={autoPilotRunning}
            autoQueue={autoQueue}
            onAutoQueue={handleAnalyzeAllUnjudgedHigh}
            recommendations={{ BUY: buyRecommendations, WATCH: watchRecommendations, REJECTED: rejectedRecommendations }}
            recTab={recommendationFilterTab}
            onRecTab={setRecommendationFilterTab}
            inPortfolio={(id) => Boolean(paperPortfolio[id])}
            rows={filteredItems}
            counts={{
              all: baseFiltered.length,
              ceo_cfo: ceoCfoCount,
              csuite: cSuiteCount,
              cluster_discount: clusterDiscountCount,
              below_insider: belowInsiderCount,
              csuite_cluster: csuiteClusterCount,
              us: usCount,
              nordic: nordicCount,
            }}
            quickFilter={quickFilter}
            onQuickFilter={setQuickFilter}
            regionFilter={regionFilter}
            onRegionFilter={setRegionFilter}
            verdictHistory={verdictHistory}
            selectedId={selectedTx?.id ?? null}
            councilLoading={councilLoading}
            onOpen={(tx, verdict) => {
              setSelectedTx(tx);
              setActiveVerdict(verdict);
            }}
          />
        )}

        {activeTab === 'watchlist' && (
          <VerdictsTab
            items={savedVerdictItems}
            avgStrongAlpha={avgStrongAlpha}
            refreshing={refreshingAlpha}
            onRefresh={handleRefreshWatchlistAlpha}
            onRemove={handleRemoveFromWatchlist}
            onOpen={(item) => {
              setSelectedTx(item.transaction);
              setActiveVerdict(item.verdict);
            }}
            selectedId={selectedTx?.id ?? null}
          />
        )}

        {activeTab === 'maaling' && <MeasurementTab />}

        {activeTab === 'portfolio' && (
          <PortfolioTab
            realKpis={realKpis}
            portfolioSummaries={portfolioSummaries}
            portfolioRefreshing={portfolioRefreshing}
            portfolioRefreshedAt={portfolioRefreshedAt}
            onRefreshPortfolioLivePnl={handleRefreshPortfolioLivePnl}
            paperPortfolio={paperPortfolio}
            onGoToRadar={() => setActiveTab('radar')}
            verdictHistory={verdictHistory}
            editingPosId={editingPosId}
            setEditingPosId={setEditingPosId}
            editForm={editForm}
            setEditForm={setEditForm}
            isSavingEdit={isSavingEdit}
            onStartEdit={handleStartEdit}
            onSaveEdit={handleSaveEdit}
            onClosePaperTrade={handleClosePaperTrade}
          />
        )}
      </div>
    </AppShell>
  );
}
