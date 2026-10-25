'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  AlertTriangle,
  Bookmark,
  Brain,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Eye,
  EyeOff,
  FileText,
  Filter,
  RefreshCw,
  Scale,
  Search,
  ShieldAlert,
  Trash2,
  TrendingDown,
  TrendingUp,
  UserCheck,
  Users,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import {
  CouncilVerdict,
  GatekeeperResult,
  InsiderTransaction,
} from '@/types/insider';

interface ScanItem {
  transaction: InsiderTransaction;
  result: GatekeeperResult;
}

interface SavedVerdictItem {
  transaction: InsiderTransaction;
  verdict: CouncilVerdict;
  savedAt: string;
}

interface ScanResponse {
  success: boolean;
  source: string;
  ticker?: string | null;
  apiKeysConfigured: {
    gemini: boolean;
    anthropic: boolean;
  };
  count: number;
  items: ScanItem[];
}

const STORAGE_KEY = 'insiderops_verdicts_v1';

export default function Dashboard() {
  const [source, setSource] = useState<'mock' | 'live' | 'nordic' | 'csuite'>('mock');
  const [quickFilter, setQuickFilter] = useState<'all' | 'csuite' | 'cluster_discount'>('all');
  const [searchTicker, setSearchTicker] = useState<string>('');
  const [activeTickerQuery, setActiveTickerQuery] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'radar' | 'watchlist'>('radar');

  const [hideNoise, setHideNoise] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ScanItem[]>([]);
  const [apiKeys, setApiKeys] = useState<{ gemini: boolean; anthropic: boolean }>({
    gemini: false,
    anthropic: false,
  });

  // The Council & Persistent Watchlist State
  const [selectedTx, setSelectedTx] = useState<InsiderTransaction | null>(null);
  const [councilLoading, setCouncilLoading] = useState<boolean>(false);
  const [activeVerdict, setActiveVerdict] = useState<CouncilVerdict | null>(null);
  const [verdictHistory, setVerdictHistory] = useState<Record<string, SavedVerdictItem>>({});
  const [showContextNotes, setShowContextNotes] = useState<boolean>(true);
  const [judgeTier, setJudgeTier] = useState<'opus' | 'sonnet'>('opus');
  const [showThinking, setShowThinking] = useState<boolean>(true);
  const [memoCopied, setMemoCopied] = useState<boolean>(false);

  const generateInvestmentMemoMarkdown = (tx: InsiderTransaction, verdict: CouncilVerdict): string => {
    const dateFormatted = tx.filingDate || new Date().toISOString().split('T')[0];
    const alphaStr =
      tx.returnSinceBuyPct !== undefined
        ? `${tx.returnSinceBuyPct > 0 ? '+' : ''}${tx.returnSinceBuyPct}% (${
            tx.isTradingBelowInsiderPrice
              ? 'HANDLER UNDER INSIDERENS KØBSKURS - RABAT'
              : 'HANDLER OVER KØBSKURS'
          })`
        : 'Ikke beregnet';

    const clusterPeersStr =
      tx.clusterPeers && tx.clusterPeers.length > 0
        ? tx.clusterPeers.map((p) => `- ${p}`).join('\n')
        : tx.isClusterBuy
        ? `Bekræftet cluster buy med ${tx.clusterCount ?? 2} deltagere.`
        : 'Ingen andre registrerede med-købere i samme tidsvindue.';

    return `# INVESTMENT MEMO: ${tx.ticker} (${tx.companyName})
**Dato for indberetning:** ${dateFormatted}  
**Genereret af:** InsiderOps Multi-Agent Council  

---

## 1. Transaktion & Ledelsesprofil
- **Ticker:** $${tx.ticker}
- **Selskab:** ${tx.companyName}
- **Insider:** ${tx.insiderName}
- **Titel / Rolle:** ${tx.insiderTitle} ${tx.isExecutiveOfficer ? '(C-Suite / Direktion)' : ''}
- **Ejerskabets natur:** ${tx.ownershipNature === 'D' ? 'Direkte (D - Egne personlige aktier)' : 'Indirekte (I - Fond / Trust / Holdingselskab)'}
- **Børs & Handelbarhed (DK / Nordnet / Saxo):** ${tx.isTradableInDK !== false ? '✅ Verificeret handelbar' : '🚫 Ikke godkendt'} (${tx.exchange || 'N/A'}${tx.avgDailyDollarVolume ? `, Gns. omsætning: $${(tx.avgDailyDollarVolume >= 1000000 ? (tx.avgDailyDollarVolume / 1000000).toFixed(1) + 'M' : Math.round(tx.avgDailyDollarVolume / 1000) + 'k')}/dag` : ''})
- **Handelbarheds-status:** ${tx.tradabilityReason || (tx.isTradableInDK !== false ? 'Handelbar på standard DK mæglere' : 'Ikke verificeret')}
- **Transaktionstype:** Kode ${tx.transactionCode} (Åbent markedskøb)
- **Handelsbeløb:** $${Math.round(tx.totalValueUsd).toLocaleString()} USD (${tx.shares.toLocaleString()} aktier á $${tx.pricePerShare} USD)
- **Beholdning efter køb:** ${tx.sharesOwnedFollowing.toLocaleString()} aktier (+${tx.holdingsIncreasePct}% stigning)
- **Købskurs:** $${tx.pricePerShare} USD
- **Aktuel markedskurs:** ${tx.currentMarketPrice !== undefined ? `$${tx.currentMarketPrice} USD` : 'Ukendt'}
- **Insider Alpha / Rabat:** ${alphaStr}
- **Kursændring 30 dage op til køb:** ${tx.recentPriceChange30dPct !== undefined ? `${tx.recentPriceChange30dPct}%` : 'Ukendt'}
- **SEC Filing Link:** ${tx.secFilingUrl}

---

## 2. Cluster Analyse & Med-købere
${clusterPeersStr}

---

## 3. The Council: CIO Dom & Asymmetry Score
**Afgørelse:** ${verdict.verdict}  
**Asymmetry Score:** ${verdict.asymmetryScore}/100  
**Overskrift:** ${verdict.headline}  

### CIO Syntese (${verdict.modelsUsed?.judge || 'Opus 5.5'}):
${verdict.synthesis}

---

## 4. Specialisternes Rapporter (Claude Sonnet 5.5)

### [The Insider Profiler]
${verdict.reports.profiler}

### [The Catalyst & Asymmetry Hunter]
${verdict.reports.catalyst}

### [The Forensic Skeptic]
${verdict.reports.skeptic}

---

## 5. Fundamentale Noter & SEC Form 4 Fodnoter
${tx.contextNotes || 'Ingen yderligere noter registreret.'}

${
  verdict.judgeThinking
    ? `---

## 6. CIO Extended Thinking Trace
\`\`\`
${verdict.judgeThinking}
\`\`\`
`
    : ''
}
---
*Genereret af InsiderOps Terminal v1.2-RADAR med Claude 5.5 & Gemini Flash.*
`;
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
    a.download = `InsiderOps_${selectedTx.ticker}_${selectedTx.filingDate || 'memo'}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Indlæs gemte domme fra localStorage ved opstart
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        setVerdictHistory(parsed);
      }
    } catch (e) {
      console.warn('Kunne ikke hente gemt historik fra localStorage:', e);
    }
  }, []);

  const fetchScan = useCallback(
    async (selectedSource: 'mock' | 'live' | 'nordic' | 'csuite', tickerQuery?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const url = tickerQuery
          ? `/api/scan?ticker=${encodeURIComponent(tickerQuery)}`
          : `/api/scan?source=${selectedSource}`;

        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);
        const data: ScanResponse = await res.json();
        setItems(data.items || []);
        setApiKeys(data.apiKeysConfigured || { gemini: false, anthropic: false });

        if (tickerQuery && data.items.length === 0) {
          setError(`Ingen Form 4 filings fundet hos SEC for '${tickerQuery}'.`);
        }
      } catch (err: unknown) {
        console.error(err);
        setError('Kunne ikke hente filings fra SEC. Prøv venligst igen.');
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!activeTickerQuery) {
      fetchScan(source, null);
    }
  }, [fetchScan, source, activeTickerQuery]);

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
    fetchScan(source, null);
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
      setActiveVerdict(existing.verdict);
      const chamberEl = document.getElementById('council-chamber');
      if (chamberEl) chamberEl.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    setCouncilLoading(true);
    setActiveVerdict(null);

    const chamberEl = document.getElementById('council-chamber');
    if (chamberEl) chamberEl.scrollIntoView({ behavior: 'smooth' });

    try {
      const res = await fetch('/api/council', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction: tx, judgeTier: targetTier }),
      });
      if (!res.ok) throw new Error('Fejl under rådsmøde');
      const data = await res.json();
      if (data.verdict) {
        const newRecord: SavedVerdictItem = {
          transaction: tx,
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
    } finally {
      setCouncilLoading(false);
    }
  };

  const handleRemoveFromWatchlist = (txId: string) => {
    const updated = { ...verdictHistory };
    delete updated[txId];
    setVerdictHistory(updated);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch (err) {
      console.warn(err);
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

  // KPI Beregninger
  const totalScanned = items.length;
  const hardFilterRejected = items.filter((i) => !i.result.passedHardFilter).length;
  const highAsymmetryCount = items.filter((i) => i.result.geminiPreScore >= 75).length;
  const savedVerdictItems = Object.values(verdictHistory).sort(
    (a, b) => b.verdict.asymmetryScore - a.verdict.asymmetryScore
  );
  const councilsConvenedCount = savedVerdictItems.length;

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

  const baseFiltered = hideNoise
    ? items.filter((i) => i.result.passedHardFilter)
    : items;

  const filteredItems = baseFiltered.filter((i) => {
    if (quickFilter === 'csuite') {
      return i.transaction.isExecutiveOfficer === true;
    }
    if (quickFilter === 'cluster_discount') {
      return Boolean(
        i.transaction.isClusterBuy || i.transaction.isTradingBelowInsiderPrice
      );
    }
    return true;
  });

  const cSuiteCount = baseFiltered.filter((i) => i.transaction.isExecutiveOfficer === true).length;
  const clusterDiscountCount = baseFiltered.filter((i) =>
    Boolean(i.transaction.isClusterBuy || i.transaction.isTradingBelowInsiderPrice)
  ).length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-cyan-500 selection:text-slate-950">
      {/* Top Terminal Header */}
      <header className="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur sticky top-0 z-40 px-4 lg:px-8 py-3.5">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 font-mono font-bold text-sm">
              IO
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-mono text-base font-bold tracking-wider text-slate-100">
                  INSIDER<span className="text-cyan-400">//</span>OPS
                </h1>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                  v1.2-RADAR
                </span>
              </div>
              <p className="text-xs text-slate-400 font-mono tracking-tight">
                SEC Form 4 Information Asymmetry & Multi-Agent Council
              </p>
            </div>
          </div>

          {/* Model Status & Actions */}
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Model Badges */}
            <div className="flex items-center gap-2 text-[11px] font-mono">
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-900 border border-slate-800">
                <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-slate-400">GEMINI FLASH:</span>
                <span className={apiKeys.gemini ? 'text-emerald-400' : 'text-amber-400'}>
                  {apiKeys.gemini ? 'API AKTIV' : 'SIMULATION'}
                </span>
              </div>

              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-900 border border-slate-800">
                <span className="h-2 w-2 rounded-full bg-cyan-500 animate-pulse" />
                <span className="text-slate-400">CLAUDE SONNET + OPUS:</span>
                <span className={apiKeys.anthropic ? 'text-cyan-400' : 'text-amber-400'}>
                  {apiKeys.anthropic ? 'API AKTIV' : 'SIMULATION'}
                </span>
              </div>
            </div>

            {/* Source Switcher */}
            <div className="flex items-center rounded border border-slate-800 bg-slate-900 p-0.5 text-xs font-mono">
              <button
                onClick={() => {
                  setActiveTickerQuery(null);
                  setSource('mock');
                }}
                className={`px-2.5 py-1 rounded transition-colors ${
                  source === 'mock' && !activeTickerQuery
                    ? 'bg-cyan-500/20 text-cyan-300 font-semibold border border-cyan-500/30'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Asymmetry Lab
              </button>
              <button
                onClick={() => {
                  setActiveTickerQuery(null);
                  setSource('live');
                }}
                className={`px-2.5 py-1 rounded transition-colors ${
                  source === 'live' && !activeTickerQuery
                    ? 'bg-cyan-500/20 text-cyan-300 font-semibold border border-cyan-500/30'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Live SEC Feed
              </button>
              <button
                onClick={() => {
                  setActiveTickerQuery(null);
                  setSource('csuite');
                }}
                className={`px-2.5 py-1 rounded transition-colors flex items-center gap-1 ${
                  source === 'csuite' && !activeTickerQuery
                    ? 'bg-amber-500/20 text-amber-300 font-semibold border border-amber-500/30'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <span>👔 C-Suite Hunter</span>
              </button>
              <button
                onClick={() => {
                  setActiveTickerQuery(null);
                  setSource('nordic');
                }}
                className={`px-2.5 py-1 rounded transition-colors flex items-center gap-1 ${
                  source === 'nordic' && !activeTickerQuery
                    ? 'bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <span>Nordic / DK (MAR Art. 19)</span>
              </button>
            </div>

            {/* Scan Refresh Button */}
            <button
              onClick={() => fetchScan(source, activeTickerQuery)}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-mono text-slate-200 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-cyan-400' : ''}`} />
              Scan
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 lg:px-8 py-6 space-y-6">
        {/* KPI Bar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-slate-900/60 border border-slate-800/80 p-3.5 rounded">
            <div className="flex items-center justify-between text-slate-400 text-xs font-mono">
              <span>SCANNEDE FILINGS</span>
              <FileText className="w-3.5 h-3.5 text-slate-500" />
            </div>
            <div className="mt-2 text-2xl font-mono font-bold text-slate-100">
              {loading ? '-' : totalScanned}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">Form 4 transaktioner</div>
          </div>

          <div className="bg-slate-900/60 border border-slate-800/80 p-3.5 rounded">
            <div className="flex items-center justify-between text-slate-400 text-xs font-mono">
              <span>HARD FILTER AFVIST</span>
              <Filter className="w-3.5 h-3.5 text-rose-400" />
            </div>
            <div className="mt-2 text-2xl font-mono font-bold text-rose-400">
              {loading ? '-' : hardFilterRejected}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">0 tokens brugt på støj</div>
          </div>

          <div className="bg-slate-900/60 border border-slate-800/80 p-3.5 rounded">
            <div className="flex items-center justify-between text-slate-400 text-xs font-mono">
              <span>HØJ ASYMMETRI</span>
              <Zap className="w-3.5 h-3.5 text-emerald-400" />
            </div>
            <div className="mt-2 text-2xl font-mono font-bold text-emerald-400">
              {loading ? '-' : highAsymmetryCount}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">Pre-Score &gt; 75/100</div>
          </div>

          <div className="bg-slate-900/60 border border-slate-800/80 p-3.5 rounded">
            <div className="flex items-center justify-between text-slate-400 text-xs font-mono">
              <span>WATCHLIST / DOMME</span>
              <Bookmark className="w-3.5 h-3.5 text-cyan-400" />
            </div>
            <div className="mt-2 text-2xl font-mono font-bold text-cyan-400">
              {councilsConvenedCount}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">Gemt i localStorage</div>
          </div>
        </div>

        {/* Ticker Search Bar */}
        <div className="p-3.5 rounded bg-slate-900/70 border border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-3">
          <form
            onSubmit={handleTickerSearch}
            className="flex items-center gap-2 w-full sm:w-auto flex-1 max-w-xl"
          >
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchTicker}
                onChange={(e) => setSearchTicker(e.target.value)}
                placeholder="Deep-Scan US Ticker (f.eks. NVDA, PLTR, SOFI, CELH)..."
                className="w-full pl-9 pr-3 py-2 rounded bg-slate-950 border border-slate-800 text-xs font-mono text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500 transition-colors uppercase"
              />
            </div>
            <button
              type="submit"
              disabled={loading || !searchTicker.trim()}
              className="px-4 py-2 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-slate-950 font-mono font-bold text-xs flex items-center gap-1.5 transition-colors whitespace-nowrap"
            >
              <Cpu className="w-3.5 h-3.5" />
              Deep Scan CIK
            </button>
          </form>

          {activeTickerQuery && (
            <div className="flex items-center gap-2 text-xs font-mono bg-cyan-950/60 border border-cyan-800/80 px-3 py-1.5 rounded text-cyan-300">
              <span>SØGER PÅ TICKER:</span>
              <span className="font-bold tracking-wider">${activeTickerQuery}</span>
              <button
                onClick={handleResetSearch}
                className="hover:text-cyan-100 text-cyan-400 ml-1.5"
                title="Ryd søgning"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-1">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('radar')}
              className={`px-4 py-2 font-mono text-xs font-bold tracking-wider border-b-2 transition-colors flex items-center gap-2 ${
                activeTab === 'radar'
                  ? 'border-cyan-400 text-cyan-300 bg-slate-900/40'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              <span>RADAR SCAN</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-300">
                {filteredItems.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('watchlist')}
              className={`px-4 py-2 font-mono text-xs font-bold tracking-wider border-b-2 transition-colors flex items-center gap-2 ${
                activeTab === 'watchlist'
                  ? 'border-cyan-400 text-cyan-300 bg-slate-900/40'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Bookmark className="w-3.5 h-3.5" />
              <span>WATCHLIST / GEMTE DOMME</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-950 border border-cyan-800 text-cyan-300">
                {savedVerdictItems.length}
              </span>
            </button>
          </div>

          {activeTab === 'radar' && (
            <button
              onClick={() => setHideNoise(!hideNoise)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 transition-colors text-xs font-mono"
            >
              {hideNoise ? (
                <>
                  <Eye className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Vis afvist støj ({hardFilterRejected})</span>
                </>
              ) : (
                <>
                  <EyeOff className="w-3.5 h-3.5 text-slate-400" />
                  <span>Skjul afvist støj ({hardFilterRejected})</span>
                </>
              )}
            </button>
          )}
        </div>

        {/* Error message */}
        {error && (
          <div className="p-3 rounded bg-rose-950/40 border border-rose-800 text-rose-300 text-xs font-mono flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* TAB 1: RADAR TABLE */}
        {activeTab === 'radar' && (
          <div className="border border-slate-800 rounded bg-slate-900/40 overflow-hidden">
            {/* Quick-Filter Chips Bar */}
            <div className="flex flex-wrap items-center justify-between gap-2.5 px-4 py-2.5 bg-slate-900/80 border-b border-slate-800 text-xs font-mono">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-400 text-[11px] font-semibold mr-1 flex items-center gap-1">
                  <Filter className="w-3.5 h-3.5 text-cyan-400" /> HURTIG-FILTER:
                </span>
                <button
                  onClick={() => setQuickFilter('all')}
                  className={`px-3 py-1 rounded transition-colors flex items-center gap-1.5 ${
                    quickFilter === 'all'
                      ? 'bg-cyan-500/20 text-cyan-300 font-bold border border-cyan-500/40 shadow-sm shadow-cyan-950'
                      : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                  }`}
                >
                  <span>Alle Godkendte</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-300">
                    {baseFiltered.length}
                  </span>
                </button>
                <button
                  onClick={() => setQuickFilter('csuite')}
                  className={`px-3 py-1 rounded transition-colors flex items-center gap-1.5 ${
                    quickFilter === 'csuite'
                      ? 'bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/40 shadow-sm shadow-emerald-950'
                      : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                  }`}
                >
                  <span>👔 Kun C-Suite / Direktion (CEO/CFO/GC)</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-emerald-300">
                    {cSuiteCount}
                  </span>
                </button>
                <button
                  onClick={() => setQuickFilter('cluster_discount')}
                  className={`px-3 py-1 rounded transition-colors flex items-center gap-1.5 ${
                    quickFilter === 'cluster_discount'
                      ? 'bg-amber-500/20 text-amber-300 font-bold border border-amber-500/40 shadow-sm shadow-amber-950'
                      : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                  }`}
                >
                  <span>🔥 Kun Cluster Buys & Rabat-Cases</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-amber-300">
                    {clusterDiscountCount}
                  </span>
                </button>
              </div>
              <div className="text-[11px] text-slate-400">
                Viser <span className="text-cyan-300 font-bold">{filteredItems.length}</span> handler
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs font-mono">
                <thead>
                  <tr className="bg-slate-900/80 border-b border-slate-800 text-slate-400 text-[11px]">
                    <th className="py-3 px-3">TICKER / SELSKAB</th>
                    <th className="py-3 px-3">INSIDER & ROLLE</th>
                    <th className="py-3 px-2 text-center">TYPE</th>
                    <th className="py-3 px-3 text-right">BELØB / KURS & ALPHA</th>
                    <th className="py-3 px-3 text-right">BEHOLDNINGS-ÆNDRING</th>
                    <th className="py-3 px-3">GATEKEEPER & RÅD</th>
                    <th className="py-3 px-3 text-right">HANDLING</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {loading ? (
                    <tr>
                      <td colSpan={7} className="py-12 text-center text-slate-400">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <RefreshCw className="w-5 h-5 animate-spin text-cyan-400" />
                          <span>
                            {activeTickerQuery
                              ? `Slår CIK op og henter Form 4 filings for ${activeTickerQuery}...`
                              : 'Scanner SEC Form 4 filings og afvikler Gemini Gatekeeper...'}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ) : filteredItems.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-12 text-center text-slate-500">
                        Ingen transaktioner at vise.
                      </td>
                    </tr>
                  ) : (
                    filteredItems.map(({ transaction: tx, result: res }) => {
                      const isSelected = selectedTx?.id === tx.id;
                      const saved = verdictHistory[tx.id];
                      const isCFOorGC = /cfo|chief financial|general counsel|chief legal/i.test(
                        tx.insiderTitle
                      );
                      const isCosmeticBuy =
                        tx.transactionCode === 'P' && tx.holdingsIncreasePct < 1.0;

                      return (
                        <tr
                          key={tx.id}
                          className={`transition-colors ${
                            isSelected
                              ? 'bg-cyan-950/30'
                              : !res.passedHardFilter
                              ? 'bg-slate-950/60 opacity-60 hover:opacity-100'
                              : 'hover:bg-slate-900/60'
                          }`}
                        >
                          {/* Ticker & Company */}
                          <td className="py-3 px-3 font-semibold">
                            <div className="flex items-center gap-1.5">
                              <span className="text-cyan-400 font-bold tracking-wider">{tx.ticker}</span>
                              {tx.recentPriceChange30dPct !== undefined && (
                                <span
                                  className={`text-[10px] px-1 rounded ${
                                    tx.recentPriceChange30dPct < 0
                                      ? 'text-rose-400 bg-rose-950/40 border border-rose-900/60'
                                      : 'text-emerald-400 bg-emerald-950/40 border border-emerald-900/60'
                                  }`}
                                >
                                  {tx.recentPriceChange30dPct > 0 ? '+' : ''}
                                  {tx.recentPriceChange30dPct}% 30d
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-400 truncate max-w-[160px] font-sans">
                              {tx.companyName}
                            </div>
                            {/* Exchange & Tradability Badge */}
                            <div className="mt-1 flex items-center gap-1">
                              {tx.isTradableInDK === false ? (
                                <span
                                  className="text-[9px] px-1.5 py-0.5 rounded bg-rose-950/70 border border-rose-700 text-rose-300 font-semibold"
                                  title={tx.tradabilityReason || 'Ikke handelbar på danske børser / mæglere'}
                                >
                                  🚫 IKKE HANDELBAR I DK
                                </span>
                              ) : tx.exchange ? (
                                <span
                                  className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800/90 border border-slate-700 text-slate-300 font-mono flex items-center gap-1"
                                  title={tx.tradabilityReason || 'Handelbar på Nordnet / Saxo'}
                                >
                                  <span className="text-emerald-400 font-bold">✓</span>
                                  <span>{tx.exchange}</span>
                                  {tx.avgDailyDollarVolume ? (
                                    <span className="text-slate-400">
                                      • Vol:{' '}
                                      {tx.avgDailyDollarVolume >= 1000000
                                        ? `$${(tx.avgDailyDollarVolume / 1000000).toFixed(1)}M/d`
                                        : `$${Math.round(tx.avgDailyDollarVolume / 1000)}k/d`}
                                    </span>
                                  ) : null}
                                </span>
                              ) : null}
                            </div>
                          </td>

                          {/* Insider & Role */}
                          <td className="py-3 px-3">
                            <div className="text-slate-200 font-medium font-sans">{tx.insiderName}</div>
                            <div className="flex flex-wrap items-center gap-1 mt-1">
                              <span
                                className={`text-[10px] px-1.5 py-0.2 rounded border ${
                                  isCFOorGC
                                    ? 'bg-emerald-950/60 border-emerald-800 text-emerald-300 font-bold'
                                    : 'bg-slate-800/80 border-slate-700 text-slate-300'
                                }`}
                              >
                                {tx.insiderTitle}
                              </span>
                              {tx.isExecutiveOfficer ? (
                                <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-950/80 border border-cyan-600 text-cyan-300 font-bold flex items-center gap-0.5">
                                  👔 C-Suite
                                </span>
                              ) : tx.ownershipNature === 'I' ||
                                /10%|llc|fund|trust|capital|partners|investments/i.test(
                                  tx.insiderTitle + ' ' + tx.insiderName
                                ) ? (
                                <span
                                  className="text-[10px] px-1.5 py-0.2 rounded bg-purple-950/70 border border-purple-800 text-purple-300 flex items-center gap-0.5"
                                  title="Indirekte ejerskab via fond / trust / holdingselskab"
                                >
                                  🏢 10% Fond / Indirect
                                </span>
                              ) : (
                                <span
                                  className="text-[10px] px-1.5 py-0.2 rounded bg-slate-900 border border-slate-800 text-slate-400"
                                  title="Direkte personligt ejerskab"
                                >
                                  Direct
                                </span>
                              )}
                              {tx.isClusterBuy && (
                                <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-950/60 border border-amber-800 text-amber-300 flex items-center gap-0.5">
                                  <Users className="w-2.5 h-2.5" />
                                  Cluster ({tx.clusterCount ?? 2})
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Code */}
                          <td className="py-3 px-2 text-center">
                            <span
                              className={`px-2 py-0.5 rounded text-[11px] font-bold border ${
                                tx.transactionCode === 'P'
                                  ? 'bg-emerald-950/60 border-emerald-800 text-emerald-400'
                                  : tx.transactionCode === 'M'
                                  ? 'bg-purple-950/60 border-purple-800 text-purple-400'
                                  : tx.transactionCode === 'A'
                                  ? 'bg-blue-950/60 border-blue-800 text-blue-400'
                                  : tx.transactionCode === 'F'
                                  ? 'bg-amber-950/60 border-amber-800 text-amber-400'
                                  : 'bg-rose-950/60 border-rose-800 text-rose-400'
                              }`}
                              title={
                                tx.transactionCode === 'P'
                                  ? 'Open Market Purchase'
                                  : tx.transactionCode === 'M'
                                  ? 'Option Exercise / RSU'
                                  : tx.transactionCode === 'A'
                                  ? 'Grant / Tildeling'
                                  : tx.transactionCode === 'F'
                                  ? 'Skatte-salg / Withholding'
                                  : 'Salg'
                              }
                            >
                              {tx.transactionCode}
                            </span>
                          </td>

                          {/* Total Value & Live Insider Alpha */}
                          <td className="py-3 px-3 text-right font-mono">
                            <div className="text-slate-100 font-semibold">
                              ${Math.round(tx.totalValueUsd).toLocaleString()}
                            </div>
                            <div className="text-[10px] text-slate-500">
                              {tx.shares.toLocaleString()} stk a ${tx.pricePerShare}
                            </div>
                            {tx.currentMarketPrice !== undefined && tx.transactionCode === 'P' && (
                              <div className="mt-1 flex flex-col items-end gap-0.5">
                                <div className="text-[10px] text-slate-400">
                                  Nu: <span className="text-slate-200 font-medium">${tx.currentMarketPrice}</span>
                                  {tx.returnSinceBuyPct !== undefined && (
                                    <span
                                      className={`ml-1 font-semibold ${
                                        tx.returnSinceBuyPct < 0 ? 'text-cyan-400' : 'text-emerald-400'
                                      }`}
                                    >
                                      ({tx.returnSinceBuyPct > 0 ? '+' : ''}{tx.returnSinceBuyPct}%)
                                    </span>
                                  )}
                                </div>
                                {tx.isTradingBelowInsiderPrice &&
                                  res.passedHardFilter &&
                                  tx.returnSinceBuyPct !== undefined &&
                                  tx.returnSinceBuyPct >= -25 && (
                                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-cyan-950/90 border border-cyan-500/70 text-cyan-300 flex items-center gap-1 shadow-sm shadow-cyan-950">
                                      <span>💎 UNDER INSIDER PRIS ({tx.returnSinceBuyPct}%)</span>
                                    </span>
                                  )}
                              </div>
                            )}
                          </td>

                          {/* Holdings change */}
                          <td className="py-3 px-3 text-right font-mono">
                            <div
                              className={`font-semibold flex items-center justify-end gap-1 ${
                                tx.holdingsIncreasePct >= 15
                                  ? 'text-emerald-400'
                                  : isCosmeticBuy
                                  ? 'text-amber-400'
                                  : 'text-slate-300'
                              }`}
                            >
                              {tx.holdingsIncreasePct > 0 ? (
                                <TrendingUp className="w-3 h-3" />
                              ) : (
                                <TrendingDown className="w-3 h-3" />
                              )}
                              {tx.holdingsIncreasePct > 0 ? '+' : ''}
                              {tx.holdingsIncreasePct}%
                            </div>
                            {isCosmeticBuy && (
                              <div className="text-[10px] text-amber-400/80 font-sans">
                                Kosmetisk PR-køb
                              </div>
                            )}
                          </td>

                          {/* Gemini Gatekeeper Pre-Score & Saved Council Verdict */}
                          <td className="py-3 px-3 max-w-[280px]">
                            {res.passedHardFilter ? (
                              <div>
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span
                                    className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                                      res.geminiPreScore >= 75
                                        ? 'bg-emerald-950/70 border-emerald-700 text-emerald-300'
                                        : res.geminiPreScore >= 50
                                        ? 'bg-cyan-950/70 border-cyan-700 text-cyan-300'
                                        : 'bg-amber-950/70 border-amber-700 text-amber-300'
                                    }`}
                                  >
                                    Score: {res.geminiPreScore}/100
                                  </span>

                                  {/* Badge hvis der allerede findes en afsagt dom */}
                                  {saved && (
                                    <span
                                      className={`px-2 py-0.5 rounded text-[10px] font-bold border flex items-center gap-1 ${
                                        saved.verdict.verdict === 'STRONG ASYMMETRY (KØB)'
                                          ? 'bg-emerald-950 border-emerald-600 text-emerald-300'
                                          : saved.verdict.verdict === 'MODERATE SIGNAL (OVERVÅG)'
                                          ? 'bg-amber-950 border-amber-600 text-amber-300'
                                          : 'bg-rose-950 border-rose-600 text-rose-300'
                                      }`}
                                    >
                                      <Scale className="w-2.5 h-2.5" />
                                      CIO: {saved.verdict.asymmetryScore}/100
                                    </span>
                                  )}
                                </div>
                                <p className="text-[11px] text-slate-300 mt-1 line-clamp-2 font-sans">
                                  {res.quickReasoning}
                                </p>
                              </div>
                            ) : (
                              <div className="flex items-start gap-1.5 text-rose-400/90 text-[11px] font-sans">
                                <XCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                                <span className="line-clamp-2">{res.hardFilterReason}</span>
                              </div>
                            )}
                          </td>

                          {/* Action Button */}
                          <td className="py-3 px-3 text-right">
                            {res.passedHardFilter ? (
                              <button
                                onClick={() => handleConveneCouncil(tx)}
                                disabled={councilLoading && isSelected}
                                className={`px-3 py-1.5 rounded text-xs font-mono font-medium transition-all flex items-center gap-1.5 ml-auto ${
                                  saved
                                    ? 'bg-cyan-950/80 border border-cyan-500/60 text-cyan-300 hover:bg-cyan-900'
                                    : isSelected
                                    ? 'bg-cyan-500 text-slate-950 shadow-lg shadow-cyan-500/20'
                                    : 'bg-slate-800 hover:bg-cyan-950/80 hover:text-cyan-300 border border-slate-700 text-slate-200'
                                }`}
                              >
                                {councilLoading && isSelected ? (
                                  <>
                                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                    <span>Rådet tænker...</span>
                                  </>
                                ) : saved ? (
                                  <>
                                    <CheckCircle2 className="w-3.5 h-3.5 text-cyan-400" />
                                    <span>Vis Rådsdom</span>
                                  </>
                                ) : (
                                  <>
                                    <Scale className="w-3.5 h-3.5" />
                                    <span>Saml Rådet</span>
                                  </>
                                )}
                              </button>
                            ) : (
                              <span className="text-[11px] text-slate-600 font-mono">Afvist</span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 2: WATCHLIST / GEMTE DOMME */}
        {activeTab === 'watchlist' && (
          <div className="space-y-4">
            {/* Live Insider Alpha Tracker Header Bar */}
            <div className="p-4 rounded bg-slate-900/70 border border-slate-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-bold font-mono text-slate-100 flex items-center gap-2">
                  <Bookmark className="w-4 h-4 text-cyan-400" />
                  <span>LIVE INSIDER ALPHA TRACKER</span>
                </h3>
                <p className="text-xs text-slate-400 font-sans mt-0.5">
                  Overvågning af dine gemte cases mod aktuelle markedskurser og insider-købskurser
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {/* Avg Alpha KPI Pill */}
                <div className="px-3 py-1.5 rounded bg-slate-950 border border-slate-800 flex items-center gap-2 font-mono text-xs">
                  <span className="text-slate-400">GNS. INSIDER ALPHA (STRONG BUY):</span>
                  <span
                    className={`font-bold ${
                      avgStrongAlpha === null
                        ? 'text-slate-500'
                        : Number(avgStrongAlpha) >= 0
                        ? 'text-emerald-400'
                        : 'text-cyan-400'
                    }`}
                  >
                    {avgStrongAlpha === null
                      ? 'N/A'
                      : `${Number(avgStrongAlpha) > 0 ? '+' : ''}${avgStrongAlpha}%`}
                  </span>
                </div>

                {/* Live Refresh Button */}
                <button
                  onClick={handleRefreshWatchlistAlpha}
                  disabled={refreshingAlpha || savedVerdictItems.length === 0}
                  className="px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-slate-950 font-mono font-bold text-xs flex items-center gap-1.5 transition-colors whitespace-nowrap shadow-sm shadow-cyan-900/30"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${refreshingAlpha ? 'animate-spin' : ''}`} />
                  <span>Opdatér Live Kurser / Alpha</span>
                </button>
              </div>
            </div>

            {savedVerdictItems.length === 0 ? (
              <div className="border border-dashed border-slate-800 rounded p-12 text-center text-slate-500 font-mono text-xs">
                <Bookmark className="w-8 h-8 mx-auto mb-2 text-slate-600" />
                <p>Ingen rådsdomme er gemt endnu.</p>
                <p className="mt-1 text-slate-400">
                  Gå til &quot;Radar Scan&quot;, vælg en transaktion og klik &quot;Saml Rådet&quot;
                  for at gemme en case på din watchlist.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {savedVerdictItems.map(({ transaction: tx, verdict, savedAt }) => (
                  <div
                    key={tx.id}
                    className="p-4 rounded bg-slate-900/60 border border-slate-800 hover:border-slate-700 transition-all flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-base font-bold text-cyan-400 font-mono tracking-wider">
                            ${tx.ticker}
                          </span>
                          <span className="text-xs text-slate-400 font-sans truncate max-w-[150px]">
                            {tx.companyName}
                          </span>
                        </div>

                        <div className="flex items-center gap-2">
                          <span
                            className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold border ${
                              verdict.verdict === 'STRONG ASYMMETRY (KØB)'
                                ? 'bg-emerald-950/80 border-emerald-600 text-emerald-300'
                                : verdict.verdict === 'MODERATE SIGNAL (OVERVÅG)'
                                ? 'bg-amber-950/80 border-amber-600 text-amber-300'
                                : 'bg-rose-950/80 border-rose-600 text-rose-300'
                            }`}
                          >
                            Score: {verdict.asymmetryScore}/100
                          </span>

                          <button
                            onClick={() => handleRemoveFromWatchlist(tx.id)}
                            className="text-slate-500 hover:text-rose-400 p-1"
                            title="Fjern fra watchlist"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="mt-2 text-xs text-slate-300 font-sans font-medium flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span>
                            {tx.insiderName} ({tx.insiderTitle}) • ${Math.round(tx.totalValueUsd).toLocaleString()} (+{tx.holdingsIncreasePct}%)
                          </span>
                          {tx.isExecutiveOfficer && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-950/80 border border-cyan-600 text-cyan-300 font-mono font-bold">
                              👔 C-Suite
                            </span>
                          )}
                          {tx.ownershipNature === 'I' && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-purple-950/70 border border-purple-800 text-purple-300 font-mono">
                              🏢 Fond / Indirect
                            </span>
                          )}
                        </div>
                        {tx.currentMarketPrice !== undefined && (
                          <div className="flex items-center gap-1.5 font-mono text-[11px]">
                            <span className="text-slate-400">
                              Købt @ ${tx.pricePerShare} → Nu: <span className="text-slate-200 font-medium">${tx.currentMarketPrice}</span>
                            </span>
                            {tx.returnSinceBuyPct !== undefined && (
                              <span
                                className={`px-1.5 py-0.2 rounded font-semibold ${
                                  tx.returnSinceBuyPct < 0
                                    ? 'text-cyan-300 bg-cyan-950/60 border border-cyan-800'
                                    : 'text-emerald-300 bg-emerald-950/60 border border-emerald-800'
                                }`}
                              >
                                {tx.returnSinceBuyPct > 0 ? '+' : ''}{tx.returnSinceBuyPct}%
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      {tx.isTradingBelowInsiderPrice && (
                        <div className="mt-1.5">
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-cyan-950/80 border border-cyan-600 text-cyan-300 inline-flex items-center gap-1 shadow-sm shadow-cyan-950">
                            <span>💎 HANDLER MED RABAT IFT. INSIDER ({tx.returnSinceBuyPct}%)</span>
                          </span>
                        </div>
                      )}

                      <h4 className="mt-2 text-xs font-bold text-slate-100 font-sans leading-snug line-clamp-2">
                        {verdict.headline}
                      </h4>

                      <p className="mt-1 text-[11px] text-slate-400 font-sans line-clamp-3">
                        {verdict.synthesis}
                      </p>
                    </div>

                    <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-[11px] font-mono">
                      <span className="text-slate-500">
                        {new Date(savedAt).toLocaleDateString('da-DK', {
                          day: 'numeric',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>

                      <button
                        onClick={() => {
                          setSelectedTx(tx);
                          setActiveVerdict(verdict);
                          const chamberEl = document.getElementById('council-chamber');
                          if (chamberEl) chamberEl.scrollIntoView({ behavior: 'smooth' });
                        }}
                        className="px-2.5 py-1 rounded bg-cyan-950 hover:bg-cyan-900 border border-cyan-800 text-cyan-300 transition-colors flex items-center gap-1"
                      >
                        <Scale className="w-3 h-3" />
                        <span>Åbn i Council Chamber</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Section: The Council Chamber */}
        <div id="council-chamber" className="mt-8">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between border-b border-slate-800 pb-3 mb-4 gap-3">
            <div className="flex items-center gap-2">
              <Scale className="w-5 h-5 text-cyan-400" />
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-mono text-base font-bold text-slate-100 tracking-wider">
                    THE COUNCIL CHAMBER
                  </h2>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-purple-950 border border-purple-800 text-purple-300">
                    TIERED MULTI-MODEL
                  </span>
                </div>
                <p className="text-xs text-slate-400 font-mono">
                  Gemini Flash Gatekeeper • Sonnet Specialister • Opus / Sonnet CIO
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              {/* CIO Judge Tier Selector */}
              <div className="flex items-center rounded border border-slate-800 bg-slate-900 p-0.5 text-xs font-mono">
                <button
                  type="button"
                  onClick={() => {
                    setJudgeTier('opus');
                    if (selectedTx && activeVerdict?.modelsUsed?.judgeTier !== 'opus') {
                      handleConveneCouncil(selectedTx, true, 'opus');
                    }
                  }}
                  className={`px-2.5 py-1 rounded transition-all flex items-center gap-1.5 ${
                    judgeTier === 'opus'
                      ? 'bg-purple-950/90 text-purple-200 font-bold border border-purple-600/70 shadow-sm shadow-purple-950'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Anbefalet: Claude Opus med 2048 tokens Extended Thinking for maksimal ræsonnering"
                >
                  <Brain className="w-3.5 h-3.5 text-purple-400" />
                  <span>🧠 OPUS CIO (Deep Thinking)</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setJudgeTier('sonnet');
                    if (selectedTx && activeVerdict?.modelsUsed?.judgeTier !== 'sonnet') {
                      handleConveneCouncil(selectedTx, true, 'sonnet');
                    }
                  }}
                  className={`px-2.5 py-1 rounded transition-all flex items-center gap-1.5 ${
                    judgeTier === 'sonnet'
                      ? 'bg-cyan-950/90 text-cyan-200 font-bold border border-cyan-600/70 shadow-sm shadow-cyan-950'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Claude Sonnet for hurtig, omkostningseffektiv syntese"
                >
                  <Zap className="w-3.5 h-3.5 text-cyan-400" />
                  <span>⚡ SONNET CIO (Fast Mode)</span>
                </button>
              </div>

              {activeVerdict && (
                <button
                  onClick={() => {
                    setActiveVerdict(null);
                    setSelectedTx(null);
                  }}
                  className="text-xs font-mono text-slate-400 hover:text-slate-200 flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-800"
                >
                  <X className="w-3.5 h-3.5" />
                  Luk Chamber
                </button>
              )}
            </div>
          </div>

          {/* Loading State for The Council */}
          {councilLoading && (
            <div className="border border-cyan-500/30 bg-slate-900/60 rounded p-8 text-center space-y-4">
              <div className="inline-flex items-center justify-center p-3 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
                <RefreshCw className="w-6 h-6 animate-spin" />
              </div>
              <div>
                <h3 className="font-mono text-sm font-bold text-slate-200 tracking-wider">
                  SAMLER INVESTERINGSRÅDET THE COUNCIL...
                </h3>
                <p className="text-xs text-slate-400 mt-1 font-sans">
                  Kører 3 specialist-agenter parallelt: Profiler, Catalyst Hunter og Forensic Skeptic.
                </p>
              </div>

              {/* Parallel progress visualizer */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl mx-auto pt-2 text-xs font-mono text-left">
                <div className="p-2.5 rounded bg-slate-950 border border-slate-800 flex items-center gap-2 text-cyan-300">
                  <UserCheck className="w-4 h-4 animate-pulse text-cyan-400" />
                  <span>The Insider Profiler</span>
                </div>
                <div className="p-2.5 rounded bg-slate-950 border border-slate-800 flex items-center gap-2 text-cyan-300">
                  <Zap className="w-4 h-4 animate-pulse text-cyan-400" />
                  <span>The Catalyst Hunter</span>
                </div>
                <div className="p-2.5 rounded bg-slate-950 border border-slate-800 flex items-center gap-2 text-cyan-300">
                  <ShieldAlert className="w-4 h-4 animate-pulse text-rose-400" />
                  <span>The Forensic Skeptic</span>
                </div>
              </div>
            </div>
          )}

          {/* Council Active Verdict Display */}
          {!councilLoading && activeVerdict && selectedTx && (
            <div className="space-y-4">
              {/* CIO / Dommerens Afgørelse */}
              <div className="p-5 rounded bg-slate-900/80 border border-slate-800 shadow-xl">
                {/* Investment Memo Export Action Bar */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3 mb-4">
                  <div className="flex items-center gap-2 text-xs font-mono text-slate-400">
                    <span className="h-2 w-2 rounded-full bg-cyan-400" />
                    <span className="font-bold text-slate-200">INVESTMENT DUE DILIGENCE MEMO</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleCopyMemo}
                      className="px-3 py-1.5 rounded bg-cyan-950/80 hover:bg-cyan-900 border border-cyan-700/80 text-cyan-300 font-mono text-xs font-bold transition-all flex items-center gap-1.5 shadow-sm shadow-cyan-950"
                      title="Kopiér komplet formateret Due Diligence Investment Memo som Markdown"
                    >
                      {memoCopied ? (
                        <>
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="text-emerald-300 font-bold">Kopieret til udklipsholder!</span>
                        </>
                      ) : (
                        <>
                          <FileText className="w-3.5 h-3.5 text-cyan-400" />
                          <span>📋 Kopiér Investment Memo (MD)</span>
                        </>
                      )}
                    </button>

                    <button
                      onClick={handleDownloadMemo}
                      className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-mono text-xs font-semibold transition-all flex items-center gap-1.5"
                      title="Gem komplet Investment Memo som .md fil på computeren"
                    >
                      <Bookmark className="w-3.5 h-3.5 text-slate-400" />
                      <span>⬇️ Download .MD Memo</span>
                    </button>
                  </div>
                </div>

                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-slate-400">
                      <span>CHIEF INVESTMENT OFFICER (THE JUDGE)</span>
                      <span>•</span>
                      <span className="text-cyan-400 font-bold">
                        {selectedTx.ticker} ({selectedTx.insiderName}, {selectedTx.insiderTitle})
                      </span>
                    </div>
                    <h3 className="text-lg font-bold text-slate-100 mt-1 font-sans">
                      {activeVerdict.headline}
                    </h3>
                    {selectedTx.exchange && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[11px]">
                        <span
                          className={`px-2 py-0.5 rounded border text-[10px] font-semibold flex items-center gap-1 ${
                            selectedTx.isTradableInDK !== false
                              ? 'bg-emerald-950/70 border-emerald-700 text-emerald-300'
                              : 'bg-rose-950/70 border-rose-700 text-rose-300'
                          }`}
                        >
                          {selectedTx.isTradableInDK !== false ? '✅ Handelbar i DK' : '🚫 Ikke godkendt i DK'}: {selectedTx.exchange}
                        </span>
                        {selectedTx.avgDailyDollarVolume ? (
                          <span className="text-slate-400">
                            Gns. daglig omsætning: $
                            {selectedTx.avgDailyDollarVolume >= 1000000
                              ? `${(selectedTx.avgDailyDollarVolume / 1000000).toFixed(1)}M`
                              : `${Math.round(selectedTx.avgDailyDollarVolume / 1000)}k`}
                            /dag
                          </span>
                        ) : null}
                      </div>
                    )}
                  </div>

                  {/* Verdict Badge & Score */}
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="text-[10px] font-mono text-slate-400">ASYMMETRY SCORE</div>
                      <div className="text-3xl font-mono font-bold text-slate-100">
                        {activeVerdict.asymmetryScore}
                        <span className="text-xs text-slate-500 font-normal">/100</span>
                      </div>
                    </div>

                    <div
                      className={`px-3 py-2 rounded border font-mono text-xs font-bold tracking-wider ${
                        activeVerdict.verdict === 'STRONG ASYMMETRY (KØB)'
                          ? 'bg-emerald-950/80 border-emerald-600 text-emerald-300 shadow-lg shadow-emerald-900/30'
                          : activeVerdict.verdict === 'MODERATE SIGNAL (OVERVÅG)'
                          ? 'bg-amber-950/80 border-amber-600 text-amber-300'
                          : 'bg-rose-950/80 border-rose-600 text-rose-300'
                      }`}
                    >
                      {activeVerdict.verdict}
                    </div>
                  </div>
                </div>

                {/* Synthesis */}
                <div className="mt-4 text-xs leading-relaxed text-slate-200 font-sans space-y-2">
                  <div className="font-mono text-[11px] text-slate-400 uppercase tracking-wider">
                    DOMMERENS SAMMENFATTENDE VURDERING:
                  </div>
                  <p className="bg-slate-950/50 p-3 rounded border border-slate-800/80 text-slate-200">
                    {activeVerdict.synthesis}
                  </p>
                </div>

                {/* Model Badges */}
                <div className="mt-3 pt-3 border-t border-slate-800/60 flex flex-wrap items-center gap-2 text-[10px] font-mono">
                  <span className="text-slate-500 uppercase tracking-wider">Aktive Modeller:</span>
                  <span className="px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-800 text-emerald-300">
                    Gatekeeper: {activeVerdict.modelsUsed?.gatekeeper || 'gemini-2.5-flash'}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-cyan-950/60 border border-cyan-800 text-cyan-300">
                    Specialister: {activeVerdict.modelsUsed?.specialists || 'claude-3-7-sonnet'} (x3)
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded border ${
                      activeVerdict.modelsUsed?.judgeTier === 'opus'
                        ? 'bg-purple-950/80 border-purple-700 text-purple-200 font-semibold'
                        : 'bg-cyan-950/80 border-cyan-700 text-cyan-200'
                    }`}
                  >
                    CIO Dommer:{' '}
                    {activeVerdict.modelsUsed?.judge ||
                      (activeVerdict.modelsUsed?.judgeTier === 'sonnet'
                        ? 'claude-3-7-sonnet'
                        : 'claude-3-opus')}{' '}
                    {activeVerdict.modelsUsed?.judgeTier === 'opus'
                      ? '[Extended Thinking 2048 tok]'
                      : '[Fast Mode]'}
                  </span>
                </div>
              </div>

              {/* CIO Extended Thinking Trace Fold-Out Panel */}
              {activeVerdict.judgeThinking && (
                <div className="rounded bg-slate-950 border border-purple-900/60 overflow-hidden shadow-lg shadow-purple-950/20">
                  <button
                    onClick={() => setShowThinking(!showThinking)}
                    className="w-full px-4 py-2.5 bg-gradient-to-r from-purple-950/60 via-slate-900 to-slate-900 hover:from-purple-950/80 transition-colors flex items-center justify-between text-left font-mono text-xs border-b border-purple-900/40"
                  >
                    <div className="flex items-center gap-2 text-purple-300 font-bold tracking-wide">
                      <Brain className="w-4 h-4 text-purple-400 animate-pulse" />
                      <span>🧠 CIO EXTENDED THINKING // INTERN RÆSONNERING (RAW COGNITIVE TRACE)</span>
                    </div>
                    <div className="flex items-center gap-2 text-purple-300/80 text-[11px]">
                      <span className="px-1.5 py-0.5 rounded bg-purple-900/50 border border-purple-700/60 text-purple-200">
                        {activeVerdict.modelsUsed?.judgeTier === 'opus'
                          ? 'OPUS • 2048 TOKENS BUDGET'
                          : 'SONNET • FAST REASONING'}
                      </span>
                      <span>{showThinking ? 'Skjul tankestrøm' : 'Vis tankestrøm'}</span>
                      <ChevronDown
                        className={`w-3.5 h-3.5 transition-transform ${
                          showThinking ? 'rotate-180' : ''
                        }`}
                      />
                    </div>
                  </button>
                  {showThinking && (
                    <div className="p-4 bg-slate-950 text-[11px] font-mono leading-relaxed text-purple-200/90 whitespace-pre-wrap max-h-80 overflow-y-auto selection:bg-purple-900 selection:text-purple-100 border-t border-purple-950 space-y-1">
                      {activeVerdict.judgeThinking}
                    </div>
                  )}
                </div>
              )}

              {/* 3 Specialist Reports Side by Side */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Agent 1: The Insider Profiler */}
                <div className="p-4 rounded bg-slate-900/60 border border-slate-800 flex flex-col">
                  <div className="flex items-center gap-2 border-b border-slate-800/80 pb-2.5">
                    <div className="p-1.5 rounded bg-cyan-950 border border-cyan-800 text-cyan-400">
                      <UserCheck className="w-4 h-4" />
                    </div>
                    <div>
                      <h4 className="font-mono text-xs font-bold text-slate-100">THE INSIDER PROFILER</h4>
                      <p className="text-[10px] text-slate-400">Magtposition & Skin-in-the-game</p>
                    </div>
                  </div>
                  <div className="mt-3 text-xs leading-relaxed text-slate-300 font-sans flex-1">
                    {activeVerdict.reports.profiler}
                  </div>
                </div>

                {/* Agent 2: The Catalyst Hunter */}
                <div className="p-4 rounded bg-slate-900/60 border border-slate-800 flex flex-col">
                  <div className="flex items-center gap-2 border-b border-slate-800/80 pb-2.5">
                    <div className="p-1.5 rounded bg-emerald-950 border border-emerald-800 text-emerald-400">
                      <Zap className="w-4 h-4" />
                    </div>
                    <div>
                      <h4 className="font-mono text-xs font-bold text-slate-100">THE CATALYST HUNTER</h4>
                      <p className="text-[10px] text-slate-400">Informationsasymmetri & Timing</p>
                    </div>
                  </div>
                  <div className="mt-3 text-xs leading-relaxed text-slate-300 font-sans flex-1">
                    {activeVerdict.reports.catalyst}
                  </div>
                </div>

                {/* Agent 3: The Forensic Skeptic */}
                <div className="p-4 rounded bg-slate-900/60 border border-slate-800 flex flex-col">
                  <div className="flex items-center gap-2 border-b border-slate-800/80 pb-2.5">
                    <div className="p-1.5 rounded bg-rose-950 border border-rose-800 text-rose-400">
                      <ShieldAlert className="w-4 h-4" />
                    </div>
                    <div>
                      <h4 className="font-mono text-xs font-bold text-slate-100">THE FORENSIC SKEPTIC</h4>
                      <p className="text-[10px] text-slate-400">Djævelens Advokat & Value Traps</p>
                    </div>
                  </div>
                  <div className="mt-3 text-xs leading-relaxed text-slate-300 font-sans flex-1">
                    {activeVerdict.reports.skeptic}
                  </div>
                </div>
              </div>

              {/* Live Market & News Context Notes Fold-Out Panel */}
              {selectedTx.contextNotes && (
                <div className="rounded bg-slate-900/60 border border-slate-800 overflow-hidden shadow-sm">
                  <button
                    onClick={() => setShowContextNotes(!showContextNotes)}
                    className="w-full px-4 py-2.5 bg-slate-900/90 hover:bg-slate-800/80 transition-colors flex items-center justify-between text-left font-mono text-xs"
                  >
                    <div className="flex items-center gap-2 text-cyan-400 font-bold tracking-wide">
                      <Activity className="w-3.5 h-3.5" />
                      <span>MARKEDSKONTEKST & NYHEDER (GRUNDLAG FOR RÅDETS DOM)</span>
                    </div>
                    <div className="flex items-center gap-2 text-slate-400 text-[11px]">
                      <span>{showContextNotes ? 'Skjul detaljer' : 'Vis kurs & nyheder'}</span>
                      <ChevronDown
                        className={`w-3.5 h-3.5 transition-transform ${
                          showContextNotes ? 'rotate-180' : ''
                        }`}
                      />
                    </div>
                  </button>
                  {showContextNotes && (
                    <div className="p-4 border-t border-slate-800/80 bg-slate-950/60 text-xs font-sans space-y-2 text-slate-300 leading-relaxed whitespace-pre-line">
                      {selectedTx.contextNotes}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Empty State when no verdict is active */}
          {!councilLoading && !activeVerdict && (
            <div className="border border-dashed border-slate-800 rounded p-8 text-center text-slate-500 font-mono text-xs">
              <Scale className="w-6 h-6 mx-auto mb-2 text-slate-600" />
              <span>Vælg en godkendt transaktion fra radaren ovenfor og klik på </span>
              <span className="text-cyan-400 font-bold">&quot;Saml Rådet&quot;</span>
              <span> for at starte The Council Chamber.</span>
            </div>
          )}
        </div>
      </main>

      {/* Terminal Footer */}
      <footer className="border-t border-slate-800/80 bg-slate-950 px-4 py-3 mt-12 text-center text-[11px] font-mono text-slate-500">
        <span>INSIDER//OPS SEC FORM 4 INTELLIGENCE • SYSTEM ACTIVE • STRICT ZERO-LEAKAGE ARCHITECTURE</span>
      </footer>
    </div>
  );
}
