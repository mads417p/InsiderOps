'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Cpu,
  Eye,
  EyeOff,
  FileText,
  Filter,
  Layers,
  RefreshCw,
  Scale,
  ShieldAlert,
  Sparkles,
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

interface ScanResponse {
  success: boolean;
  source: string;
  apiKeysConfigured: {
    gemini: boolean;
    anthropic: boolean;
  };
  count: number;
  items: ScanItem[];
}

export default function Dashboard() {
  const [source, setSource] = useState<'mock' | 'live'>('mock');
  const [hideNoise, setHideNoise] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ScanItem[]>([]);
  const [apiKeys, setApiKeys] = useState<{ gemini: boolean; anthropic: boolean }>({
    gemini: false,
    anthropic: false,
  });

  // The Council State
  const [selectedTx, setSelectedTx] = useState<InsiderTransaction | null>(null);
  const [councilLoading, setCouncilLoading] = useState<boolean>(false);
  const [activeVerdict, setActiveVerdict] = useState<CouncilVerdict | null>(null);
  const [verdictHistory, setVerdictHistory] = useState<Record<string, CouncilVerdict>>({});

  const fetchScan = useCallback(async (selectedSource: 'mock' | 'live') => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/scan?source=${selectedSource}`);
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data: ScanResponse = await res.json();
      setItems(data.items || []);
      setApiKeys(data.apiKeysConfigured || { gemini: false, anthropic: false });
    } catch (err: unknown) {
      console.error(err);
      setError('Kunne ikke hente Form 4 filings. Prøv venligst igen.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchScan(source);
  }, [fetchScan, source]);

  const handleConveneCouncil = async (tx: InsiderTransaction) => {
    setSelectedTx(tx);
    // Tjek om vi allerede har analyseret denne transaktion
    if (verdictHistory[tx.id]) {
      setActiveVerdict(verdictHistory[tx.id]);
      return;
    }

    setCouncilLoading(true);
    setActiveVerdict(null);
    try {
      const res = await fetch('/api/council', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction: tx }),
      });
      if (!res.ok) throw new Error('Fejl under rådsmøde');
      const data = await res.json();
      if (data.verdict) {
        setActiveVerdict(data.verdict);
        setVerdictHistory((prev) => ({ ...prev, [tx.id]: data.verdict }));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setCouncilLoading(false);
    }
  };

  // KPI Beregninger
  const totalScanned = items.length;
  const hardFilterRejected = items.filter((i) => !i.result.passedHardFilter).length;
  const highAsymmetryCount = items.filter((i) => i.result.geminiPreScore >= 75).length;
  const councilsConvenedCount = Object.keys(verdictHistory).length;

  const filteredItems = hideNoise
    ? items.filter((i) => i.result.passedHardFilter)
    : items;

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
                  v1.0-RADAR
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
                <span className="text-slate-400">GEMINI 2.5 FLASH:</span>
                <span className={apiKeys.gemini ? 'text-emerald-400' : 'text-amber-400'}>
                  {apiKeys.gemini ? 'API AKTIV' : 'SIMULATION MODE'}
                </span>
              </div>

              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-900 border border-slate-800">
                <span className="h-2 w-2 rounded-full bg-cyan-500 animate-pulse" />
                <span className="text-slate-400">CLAUDE 3.7 SONNET x4:</span>
                <span className={apiKeys.anthropic ? 'text-cyan-400' : 'text-amber-400'}>
                  {apiKeys.anthropic ? 'API AKTIV' : 'SIMULATION MODE'}
                </span>
              </div>
            </div>

            {/* Source Switcher */}
            <div className="flex items-center rounded border border-slate-800 bg-slate-900 p-0.5 text-xs font-mono">
              <button
                onClick={() => setSource('mock')}
                className={`px-3 py-1 rounded transition-colors ${
                  source === 'mock'
                    ? 'bg-cyan-500/20 text-cyan-300 font-semibold border border-cyan-500/30'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Test Cases (Asymmetry Lab)
              </button>
              <button
                onClick={() => setSource('live')}
                className={`px-3 py-1 rounded transition-colors ${
                  source === 'live'
                    ? 'bg-cyan-500/20 text-cyan-300 font-semibold border border-cyan-500/30'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Live SEC EDGAR Feed
              </button>
            </div>

            {/* Scan Refresh Button */}
            <button
              onClick={() => fetchScan(source)}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-mono text-slate-200 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-cyan-400' : ''}`} />
              Scan Now
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
            <div className="text-[11px] text-slate-500 mt-1">Form 4 transaktioner i batchet</div>
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
              <span>RÅDS-DOMME AFSAGT</span>
              <Scale className="w-3.5 h-3.5 text-cyan-400" />
            </div>
            <div className="mt-2 text-2xl font-mono font-bold text-cyan-400">
              {councilsConvenedCount}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">Claude The Council analyser</div>
          </div>
        </div>

        {/* Toolbar: Noise filter toggle & status */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-2 text-xs font-mono">
          <div className="flex items-center gap-2 text-slate-400">
            <Activity className="w-3.5 h-3.5 text-cyan-400" />
            <span>RADAR FEED: {source === 'mock' ? 'ASYMMETRY LAB (6 CASES)' : 'SEC EDGAR LIVE'}</span>
          </div>

          <button
            onClick={() => setHideNoise(!hideNoise)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 transition-colors"
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
        </div>

        {/* Error message */}
        {error && (
          <div className="p-3 rounded bg-rose-950/40 border border-rose-800 text-rose-300 text-xs font-mono flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Radar Table */}
        <div className="border border-slate-800 rounded bg-slate-900/40 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs font-mono">
              <thead>
                <tr className="bg-slate-900/80 border-b border-slate-800 text-slate-400 text-[11px]">
                  <th className="py-3 px-3">TICKER / SELSKAB</th>
                  <th className="py-3 px-3">INSIDER & ROLLE</th>
                  <th className="py-3 px-2 text-center">TYPE</th>
                  <th className="py-3 px-3 text-right">BELØB (USD)</th>
                  <th className="py-3 px-3 text-right">BEHOLDNINGS-ÆNDRING</th>
                  <th className="py-3 px-3">GEMINI GATEKEEPER PRE-SCORE</th>
                  <th className="py-3 px-3 text-right">HANDLING</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-slate-400">
                      <div className="flex flex-col items-center justify-center gap-2">
                        <RefreshCw className="w-5 h-5 animate-spin text-cyan-400" />
                        <span>Scanner SEC Form 4 filings og afvikler Gemini Gatekeeper...</span>
                      </div>
                    </td>
                  </tr>
                ) : filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-500">
                      Ingen transaktioner at vise.
                    </td>
                  </tr>
                ) : (
                  filteredItems.map(({ transaction: tx, result: res }) => {
                    const isSelected = selectedTx?.id === tx.id;
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
                        </td>

                        {/* Insider & Role */}
                        <td className="py-3 px-3">
                          <div className="text-slate-200 font-medium font-sans">{tx.insiderName}</div>
                          <div className="flex flex-wrap items-center gap-1 mt-0.5">
                            <span
                              className={`text-[10px] px-1.5 py-0.2 rounded border ${
                                isCFOorGC
                                  ? 'bg-emerald-950/60 border-emerald-800 text-emerald-300 font-bold'
                                  : 'bg-slate-800/80 border-slate-700 text-slate-300'
                              }`}
                            >
                              {tx.insiderTitle}
                            </span>
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
                                : 'bg-rose-950/60 border-rose-800 text-rose-400'
                            }`}
                          >
                            {tx.transactionCode}
                          </span>
                        </td>

                        {/* Total Value */}
                        <td className="py-3 px-3 text-right font-mono">
                          <div className="text-slate-100 font-semibold">
                            ${Math.round(tx.totalValueUsd).toLocaleString()}
                          </div>
                          <div className="text-[10px] text-slate-500">
                            {tx.shares.toLocaleString()} stk a ${tx.pricePerShare}
                          </div>
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

                        {/* Gemini Gatekeeper Pre-Score */}
                        <td className="py-3 px-3 max-w-[280px]">
                          {res.passedHardFilter ? (
                            <div>
                              <div className="flex items-center gap-2">
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
                                <span className="text-[10px] text-slate-400 font-mono">
                                  [{res.asymmetrySignal}]
                                </span>
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

                        {/* Action: Saml Rådet */}
                        <td className="py-3 px-3 text-right">
                          {res.passedHardFilter ? (
                            <button
                              onClick={() => handleConveneCouncil(tx)}
                              disabled={councilLoading && isSelected}
                              className={`px-3 py-1.5 rounded text-xs font-mono font-medium transition-all flex items-center gap-1.5 ml-auto ${
                                isSelected
                                  ? 'bg-cyan-500 text-slate-950 shadow-lg shadow-cyan-500/20'
                                  : 'bg-slate-800 hover:bg-cyan-950/80 hover:text-cyan-300 border border-slate-700 text-slate-200'
                              }`}
                            >
                              {councilLoading && isSelected ? (
                                <>
                                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                  <span>Afventer...</span>
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

        {/* Section: The Council Chamber */}
        <div id="council-chamber" className="mt-8">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
            <div className="flex items-center gap-2">
              <Scale className="w-5 h-5 text-cyan-400" />
              <h2 className="font-mono text-base font-bold text-slate-100 tracking-wider">
                THE COUNCIL CHAMBER
              </h2>
              <span className="text-xs text-slate-400 font-mono">
                [4x Claude 3.7 Sonnet Multi-Agent System]
              </span>
            </div>

            {activeVerdict && (
              <button
                onClick={() => {
                  setActiveVerdict(null);
                  setSelectedTx(null);
                }}
                className="text-xs font-mono text-slate-400 hover:text-slate-200 flex items-center gap-1"
              >
                <X className="w-3.5 h-3.5" />
                Luk Chamber
              </button>
            )}
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
              </div>

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
