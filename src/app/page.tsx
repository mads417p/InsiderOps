'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  AlertTriangle,
  Bookmark,
  Brain,
  Briefcase,
  Calculator,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Edit3,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Filter,
  Flame,
  Landmark,
  Play,
  RefreshCw,
  Scale,
  Search,
  ShieldAlert,
  ShieldCheck,
  Target,
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
  GatekeeperUsage,
  InsiderTransaction,
  PaperTradePosition,
  PortfolioSummary,
  RejectedRow,
  TradeType,
} from '@/types/insider';
import { generateTradeExecutionPlan } from '@/lib/trade-planner';
import { collectRejected, isModelScore, runwayLabel, TONE_CLASS } from '@/lib/ui-labels';
import { RejectedNoisePanel } from '@/components/RejectedNoisePanel';
import { latestValidatedVerdict } from '@/lib/verdicts';
import { PositionVerdict } from '@/components/PositionVerdict';
import { ClusterBuyers } from '@/components/ClusterBuyers';
import { currencyForTicker, type LiveFxRates } from '@/lib/live-quote';
import { formatCompactUsd } from '@/lib/fundamentals';

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
    gatekeeperProvider?: 'claude' | 'gemini';
    gatekeeperModel?: string;
  };
  count: number;
  items: ScanItem[];
  gatekeeperUsage?: GatekeeperUsage | null;
  scannedAt?: string | null;
  saved?: boolean; // true = ?latest=1: seneste gemte scan, ingen ny scan kørt
  ledger?: { inserted: number; seen: number; scored: number } | { error: string } | null;
  stale?: boolean; // true = live-hentning fejlede, items er den seneste gemte scan
  errors?: Array<{ source: string; error: string }>;
  rejectedCount?: number;
  rejected?: RejectedRow[];
  error?: string;
}

const STORAGE_KEY = 'insiderops_verdicts_v1';
const CAPITAL_STORAGE_KEY = 'insiderops_capital_frame_dkk';

/** Valutamærke for insiderens kurs (tx.currency) og for markedskursen (børsens valuta). */
const curLabel = (c: string) => (c === 'USD' ? '$' : `${c} `);
const priceLabel = (tx: InsiderTransaction) => curLabel((tx.currency || 'USD').toUpperCase());
const marketPriceLabel = (ticker: string) => curLabel(currencyForTicker(ticker));

function formatQuoteTime(isoOrStr?: string): string {
  if (!isoOrStr) return 'ukendt';
  try {
    const d = new Date(isoOrStr);
    if (!isNaN(d.getTime())) {
      return d.toLocaleString('da-DK', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }
  } catch {}
  return isoOrStr;
}

function formatDateTimeDk(isoOrStr?: string): string {
  if (!isoOrStr) return 'Ukendt tidspunkt';
  try {
    const d = new Date(isoOrStr);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString('da-DK', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
  } catch {}
  return isoOrStr;
}

function getRegionBadge(
  ticker: string,
  exchange?: string
): { flag: string; code: string; label: string } {
  const t = (ticker || '').toUpperCase();
  const ex = (exchange || '').toUpperCase();
  if (t.endsWith('.CO') || ex.includes('COPENHAGEN') || ex.includes('CPH')) {
    return { flag: '🇩🇰', code: 'DK', label: 'Danmark (Nasdaq Copenhagen)' };
  }
  if (t.endsWith('.ST') || ex.includes('STOCKHOLM') || ex.includes('STO')) {
    return { flag: '🇸🇪', code: 'SE', label: 'Sverige (Nasdaq Stockholm)' };
  }
  if (t.endsWith('.HE') || ex.includes('HELSINKI') || ex.includes('HEL')) {
    return { flag: '🇫🇮', code: 'FI', label: 'Finland (Nasdaq Helsinki)' };
  }
  return { flag: '🇺🇸', code: 'US', label: 'USA (NYSE / NASDAQ)' };
}

export default function Dashboard() {
  const [source, setSource] = useState<'unified' | 'csuite' | 'live' | 'nordic' | 'mock'>('unified');
  const [regionFilter, setRegionFilter] = useState<'all' | 'us' | 'nordic'>('all');
  const [quickFilter, setQuickFilter] = useState<
    'all' | 'csuite' | 'cluster_discount' | 'below_insider' | 'csuite_cluster'
  >('all');
  const [searchTicker, setSearchTicker] = useState<string>('');
  const [activeTickerQuery, setActiveTickerQuery] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'radar' | 'watchlist' | 'portfolio'>('radar');

  const [showRejected, setShowRejected] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  // Rådsfejl vises for brugeren – der findes ingen simuleret eller fallback-dom.
  const [councilError, setCouncilError] = useState<string | null>(null);
  const [items, setItems] = useState<ScanItem[]>([]);
  // Rækker afvist allerede i scan-pipelinen (kode, beløb, handelbarhed, Norden) – de er ikke i items.
  const [scanRejected, setScanRejected] = useState<RejectedRow[]>([]);
  const [apiKeys, setApiKeys] = useState<ScanResponse['apiKeysConfigured']>({
    gemini: false,
    anthropic: false,
  });
  const [gatekeeperUsage, setGatekeeperUsage] = useState<GatekeeperUsage | null>(null);
  const [scannedAt, setScannedAt] = useState<string | null>(null);

  // Paper-Trading Portfolio State
  const [paperPortfolio, setPaperPortfolio] = useState<Record<string, PaperTradePosition>>({});
  // Én opsummering pr. handelstype – PAPER og REAL_NORDNET blandes aldrig i KPI'erne.
  const [portfolioSummaries, setPortfolioSummaries] = useState<Partial<Record<TradeType, PortfolioSummary>>>({});
  // Live FX fra /api/portfolio – uden den laver trade-planneren ingen plan (ingen hårdkodede kurser).
  const [fxRates, setFxRates] = useState<LiveFxRates | null>(null);
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
  const autoPilotProgress = councilQueueProgress;

  const generateInvestmentMemoMarkdown = (tx: InsiderTransaction, verdict: CouncilVerdict): string => {
    const dateFormatted = tx.tradeDate ? `${tx.tradeDate} (handelsdato)` : tx.filedAt ? `${tx.filedAt.slice(0, 10)} (indberettet)` : 'ukendt';
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
- **Ejerskabets natur:** ${tx.ownershipNature === 'D' ? 'Direkte (D - Egne personlige aktier)' : tx.ownershipNature === 'I' ? `Indirekte (I - ${tx.ownershipVia || 'Fond / Trust / Holdingselskab'})` : 'Ukendt (D/I ikke oplyst)'}
${tx.offeringNote ? `- **Udbud:** ⚠️ ${tx.offeringNote}\n` : ''}${tx.personalBuyers !== undefined && tx.isClusterBuy ? `- **Købere:** personlige købere: ${tx.personalBuyers}, via fonde: ${tx.fundBuyers ?? 0}\n` : ''}
- **Rule 10b5-1 Handelsplan:** ${tx.is10b51Plan === undefined ? '❔ Ukendt (Form 4 ikke tjekket)' : tx.is10b51Plan ? '⚠️ JA (Automatisk forudbestemt plan - 0% aktuel asymmetri)' : '✅ NEJ (Frivilligt, skønsmæssigt køb på åbent marked)'}
${tx.footnotesSummary ? `- **SEC Fodnoter (Det med småt):**\n${tx.footnotesSummary}\n` : ''}- **Børs & Handelbarhed (DK / Nordnet / Saxo):** ${tx.isTradableInDK === true ? '✅ Verificeret handelbar' : tx.isTradableInDK === false ? '🚫 Ikke godkendt' : '❔ Ikke verificeret – mangler data'} (${tx.exchange || 'N/A'}${tx.avgDailyDollarVolume ? `, Gns. omsætning: $${(tx.avgDailyDollarVolume >= 1000000 ? (tx.avgDailyDollarVolume / 1000000).toFixed(1) + 'M' : Math.round(tx.avgDailyDollarVolume / 1000) + 'k')}/dag` : ''})
- **Handelbarheds-status:** ${tx.tradabilityReason || (tx.isTradableInDK === true ? 'Handelbar på standard DK mæglere' : tx.isTradableInDK === false ? 'Ikke handelbar' : 'Handelbarhed ikke verificeret')}
- **Transaktionstype:** Kode ${tx.transactionCode} (Åbent markedskøb)
- **Handelsbeløb:** ${tx.totalValueLocal !== undefined ? `${Math.round(tx.totalValueLocal).toLocaleString()} ${tx.currency} (ca. $${Math.round(tx.totalValueUsd).toLocaleString()} USD)` : `$${Math.round(tx.totalValueUsd).toLocaleString()} USD`} (${tx.shares.toLocaleString()} aktier á ${priceLabel(tx)}${tx.pricePerShare})
- **Beholdning efter køb:** ${tx.sharesOwnedFollowing !== undefined ? `${tx.sharesOwnedFollowing.toLocaleString()} aktier` : 'ikke oplyst'} (${tx.holdingsIncreasePct !== undefined ? `+${tx.holdingsIncreasePct}%` : 'ukendt'} stigning)
- **Købskurs:** ${priceLabel(tx)}${tx.pricePerShare}
- **Aktuel markedskurs:** ${tx.currentMarketPrice !== undefined ? `$${tx.currentMarketPrice} USD` : 'Ukendt'}
- **Insider Alpha / Rabat:** ${alphaStr}
- **Kursændring 30 dage op til køb:** ${tx.recentPriceChange30dPct !== undefined ? `${tx.recentPriceChange30dPct}%` : 'Ukendt'}
- **SEC Filing Link:** ${tx.secFilingUrl}

---

## 2. Cluster Analyse & Med-købere
${clusterPeersStr}

---

## 3. Insider Track Record & Historisk Træfsikkerhed
${
  tx.trackRecord && tx.trackRecord.reputation !== 'UNKNOWN'
    ? `- **Status & Omdømme:** ${tx.trackRecord.reputationLabel}
- **Målte køb (selskabet, 4 år, afkast efter 6 mdr.):** ${tx.trackRecord.historicalBuysCount} handler (+${tx.trackRecord.unmeasuredBuysCount ?? 0} for nye til at måle${tx.trackRecord.excludedOfferingBuys ? `; ${tx.trackRecord.excludedOfferingBuys} køb i udbud/IPO udeladt` : ''})
- **Historisk Win-Rate:** ${tx.trackRecord.winRatePct}%
- **Gennemsnitligt afkast efter 6 mdr.:** ${tx.trackRecord.avgReturnPct > 0 ? '+' : ''}${tx.trackRecord.avgReturnPct}%
- **Insiderens egne målte køb:** ${tx.trackRecord.insiderOnly ? `${tx.trackRecord.insiderOnly.historicalBuysCount} (win rate ${tx.trackRecord.insiderOnly.winRatePct}%, gns. ${tx.trackRecord.insiderOnly.avgReturnPct}%)` : 'ikke opgjort'}
${
  tx.trackRecord.notablePastTrades.length > 0
    ? `\n### Udvalgte tidligere handler i aktien:\n` +
      tx.trackRecord.notablePastTrades
        .map(
          (t) =>
            `- **${t.date}:** ${t.insiderName} (${t.insiderTitle || 'Insider'}) købte @ $${t.price} ($${Math.round(
              t.valueUsd
            ).toLocaleString()}) -> Nuværende afkast: **${t.returnPct > 0 ? '+' : ''}${t.returnPct}%**`
        )
        .join('\n')
    : ''
}`
    : `- **Track record:** mangler data${tx.trackRecord ? ` (${tx.trackRecord.reputationLabel})` : ''}`
}

---

## 4. Fundamental Balance Sheet, Cash Runway & Short Guard
${
  tx.fundamentals
    ? `- **Status & Badge:** [${tx.fundamentals.fundamentalHealthBadge}] ${tx.fundamentals.fundamentalSummary}
- **Kontanter & Værdipapirer (SEC XBRL):** ${formatCompactUsd(tx.fundamentals.cashAndEquivalentsUsd)} USD
- **Samlet Gæld (Kort- & Langfristet):** ${formatCompactUsd(tx.fundamentals.totalDebtUsd)} USD
- **Netto Kassebeholdning (Net Cash):** ${tx.fundamentals.netCashUsd !== undefined ? `${tx.fundamentals.netCashUsd >= 0 ? '+' : ''}${formatCompactUsd(tx.fundamentals.netCashUsd)} USD` : 'Ukendt'}
- **Drift Cash Flow & Burn Rate:** ${
        tx.fundamentals.isCashFlowPositive
          ? 'Positiv Drift (Cash-Flow Positiv)'
          : tx.fundamentals.quarterlyCashBurnUsd
          ? `-${formatCompactUsd(tx.fundamentals.quarterlyCashBurnUsd)}/kvartal i cash burn`
          : 'Ukendt'
      }
- **Estimeret Kontant Runway:** ${
        tx.fundamentals.isCashFlowPositive
          ? 'Uendelig / Selvfinansierende (Cash-Flow Positiv)'
          : tx.fundamentals.estimatedRunwayMonths !== null && tx.fundamentals.estimatedRunwayMonths !== undefined
          ? `${tx.fundamentals.estimatedRunwayMonths} måneder`
          : 'Ukendt'
      }
- **Short Interest (% af Free Float):** ${tx.fundamentals.shortPercentOfFloat !== undefined ? `${tx.fundamentals.shortPercentOfFloat.toFixed(1)}%` : 'N/A'}${
        (tx.fundamentals.shortPercentOfFloat ?? 0) >= 10 ? ' 🔥 (Høj short-interesse - Squeeze potentiale)' : ''
      }
- **Short Ratio (Days to Cover):** ${tx.fundamentals.daysToCover !== undefined ? `${tx.fundamentals.daysToCover} dage` : 'N/A'}
- **Næste Kvartalsregnskab:** ${tx.fundamentals.nextEarningsDate || 'mangler data'}${
        tx.fundamentals.nextEarningsDateEstimated ? ' (estimeret)' : ''
      }${
        tx.fundamentals.daysUntilEarnings !== undefined
          ? ` (${tx.fundamentals.daysUntilEarnings === 0 ? 'I dag' : `om ${tx.fundamentals.daysUntilEarnings} dage`})`
          : ''
      }
- **Multipler:** P/E: ${tx.fundamentals.peRatio ?? 'N/A'} | P/B: ${tx.fundamentals.priceToBook ?? 'N/A'}`
    : '- **Balance:** mangler data (ingen regnskabsbalance udtrukket).'
}

---

## 5. The Council: CIO Dom & Asymmetry Score
**Afgørelse:** ${verdict.verdict}  
**Asymmetry Score:** ${verdict.asymmetryScore}/100  
**Overskrift:** ${verdict.headline}  

### CIO Syntese (${verdict.modelsUsed?.judge || 'ukendt model'}):
${verdict.synthesis}

---

## 6. Kvantitativ Eksekverings- & Risikoplan (Frie Midler)
${(() => {
  const plan = generateTradeExecutionPlan(tx, verdict, maxCapitalDkk, fxRates);
  if (plan.status === 'DO_NOT_TRADE') {
    return `- **Status:** 🛡️ Kapitalbeskyttelse aktiveret (${plan.reason})`;
  }
  return `- **Allokeringsramme:** ${maxCapitalDkk.toLocaleString()} DKK
- **Anbefalet Allokering:** ${plan.recommendedAllocationDkk.toLocaleString()} DKK (~$${plan.recommendedAllocationUsd.toLocaleString()} USD)
- **Positionstype / Antal:** ${plan.totalShares} aktier
- **Volatilitet (14d ATR):** ${plan.volatilityTag} (14d ATR: $${tx.atr14d || 'N/A'})
- **Entry Zone:** $${plan.entryZoneMin} - $${plan.entryZoneMax} (${plan.entryZoneLabel})
- **Stop-Loss (Hard Invalidation):** $${plan.stopLossPrice} (${plan.stopLossRiskPct}% risiko • Maksimalt DKK tab: ${plan.maxLossDkk.toLocaleString()} DKK)
- **Target 1 (90d Modstand / 3.5x ATR):** $${plan.targetPrice1} (+${plan.targetReturnPct1}%)
- **Risk / Reward Ratio:** 1 : ${plan.riskRewardRatio}

### Tranche Opdeling:
- **Tranche 1 (60%):** ${plan.tranche1.description} • ${plan.tranche1.allocationDkk.toLocaleString()} DKK
- **Tranche 2 (40%):** ${plan.tranche2.description} • ${plan.tranche2.allocationDkk.toLocaleString()} DKK`;
})()}

---

## 6. Specialisternes Rapporter (${verdict.modelsUsed?.specialists || 'ukendt model'})

### [The Insider Profiler]
${verdict.reports.profiler}

### [The Catalyst & Asymmetry Hunter]
${verdict.reports.catalyst}

### [The Forensic Skeptic]
${verdict.reports.skeptic}

---

## 7. Fundamentale Noter & SEC Form 4 Fodnoter
${tx.contextNotes || 'Ingen yderligere noter registreret.'}

${
  verdict.judgeThinking
    ? `---

## 8. Dommerens ræsonnement (resumé fra API)
\`\`\`
${verdict.judgeThinking}
\`\`\`
`
    : ''
}
---
*Genereret af InsiderOps Terminal v2.0-QUANT.${verdict.promptVersion ? ` Prompt-version: ${verdict.promptVersion}.` : ' Ældre dom uden skema-validering.'}*
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

    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        const cleaned: Record<string, SavedVerdictItem> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, SavedVerdictItem>)) {
          if (!isMock(k)) {
            cleaned[k] = v;
          }
        }
        setVerdictHistory(cleaned);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
      }
    } catch (e) {
      console.warn('Kunne ikke hente gemt historik fra localStorage:', e);
    }

    try {
      const storedCap = localStorage.getItem(CAPITAL_STORAGE_KEY);
      if (storedCap) {
        const val = parseInt(storedCap, 10);
        if ([10000, 25000, 50000, 100000].includes(val)) {
          setMaxCapitalDkk(val);
        }
      }
    } catch {
      // ignore
    }

    // Synkroniser med den persistente server-side database (/api/council)
    fetch('/api/council')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.verdicts) {
          setVerdictHistory((prev) => {
            // Serveren er sandheden (fx efter migration); localStorage er kun cache.
            const merged = { ...prev, ...data.verdicts };
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
            return cleaned;
          });
        }
      })
      .catch((err) => console.warn('Kunne ikke synkronisere med server-database:', err));

    // Indlæs altid friske realtids-kurser for paper-trading porteføljen ved indlæsning/F5
    fetch(`/api/portfolio?refresh=true&_t=${Date.now()}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.positions) {
          const map: Record<string, PaperTradePosition> = {};
          data.positions.forEach((p: PaperTradePosition) => {
            if (!isMock(p.id)) {
              map[p.id] = p;
            }
          });
          setPaperPortfolio(map);
          if (data.summaries) setPortfolioSummaries(data.summaries);
          if (data.fxRates) setFxRates(data.fxRates);
        }
      })
      .catch((err) => console.warn('Kunne ikke hente paper-trading portefølje:', err));
  }, []);

  const fetchScan = useCallback(
    async (
      selectedSource: 'unified' | 'csuite' | 'live' | 'nordic' | 'mock',
      tickerQuery?: string | null,
      opts: { latest?: boolean } = {}
    ) => {
      setLoading(true);
      setError(null);
      try {
        const url =
          (tickerQuery ? `/api/scan?ticker=${encodeURIComponent(tickerQuery)}` : `/api/scan?source=${selectedSource}`) +
          (opts.latest ? '&latest=1' : '');

        const res = await fetch(url);
        const data: ScanResponse = await res.json().catch(() => ({}) as ScanResponse);
        if (!res.ok) throw new Error(data.error || `HTTP-fejl ${res.status}`);
        setItems(data.items || []);
        setScanRejected(data.rejected ?? []);
        setApiKeys(data.apiKeysConfigured || { gemini: false, anthropic: false });
        setGatekeeperUsage(data.gatekeeperUsage ?? null);
        setScannedAt(data.scannedAt ?? null);

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
      } catch (err: unknown) {
        console.error(err);
        setError(`Scanningen fejlede: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // Indlæsning (og hot-reload) viser seneste gemte scan – en ny scan kører kun ved "Scan Nu" (fase 3).
  useEffect(() => {
    if (!activeTickerQuery) {
      fetchScan(source, null, { latest: true });
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
    fetchScan(source, null, { latest: true });
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
      const chamberEl = document.getElementById('council-chamber');
      if (chamberEl) chamberEl.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    setCouncilLoading(true);
    setActiveVerdict(null);
    setCouncilError(null);

    const chamberEl = document.getElementById('council-chamber');
    if (chamberEl) chamberEl.scrollIntoView({ behavior: 'smooth' });

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
        if (data.fxRates) setFxRates(data.fxRates);
      } else {
        alert(`Positionen blev ikke oprettet: ${data.error || `HTTP ${res.status}`}`);
      }
    } catch (e) {
      console.error('Fejl ved oprettelse af paper-trade:', e);
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
          const map: Record<string, PaperTradePosition> = {};
          data.positions.forEach((p: PaperTradePosition) => {
            map[p.id] = p;
          });
          setPaperPortfolio(map);
          if (data.summaries) setPortfolioSummaries(data.summaries);
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
        if (data.fxRates) setFxRates(data.fxRates);
      } else {
        alert(`Positionen blev ikke lukket: ${data.error || `HTTP ${res.status}`}`);
      }
    } catch (e) {
      console.error('Fejl ved lukning af paper-trade position:', e);
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
          if (data.fxRates) setFxRates(data.fxRates);
        setEditingPosId(null);
      }
    } catch (err) {
      console.error('Fejl ved opdatering af position:', err);
    } finally {
      setIsSavingEdit(false);
    }
  };

  // 1. Uvurderede HIGH signaler (asymmetrySignal === 'HIGH' eller score >= 75 uden rådsdom).
  //    Kun model-scorer (Claude/Gemini) – en heuristisk score må ikke starte auto-køen.
  const unjudgedHighItems = items.filter(
    (item) =>
      item.result.passedHardFilter &&
      isModelScore(item.result) &&
      (item.result.asymmetrySignal === 'HIGH' || item.result.geminiPreScore >= 75) &&
      !verdictHistory[item.transaction.id]
  );
  const unjudgedHighCount = unjudgedHighItems.length;

  // 2. Afvikling af The Council på brugerens valgte rækker (Multi-Select Queue)
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

    setCouncilQueueRunning(true);
    setActiveTab('radar');
    let currentHistory = { ...verdictHistory };
    const completed: Array<{ tx: InsiderTransaction; verdict: CouncilVerdict }> = [];
    const failures: string[] = [];
    setCouncilError(null);

    try {
      for (let i = 0; i < selectedTransactions.length; i++) {
        const tx = selectedTransactions[i];
        setCouncilQueueProgress({
          current: i + 1,
          total: selectedTransactions.length,
          ticker: tx.ticker,
          label: `Analyserer ${tx.ticker} (${i + 1}/${selectedTransactions.length})...`,
        });

        const hasOldVerdict = Boolean(currentHistory[tx.id]);

        const res = await fetch('/api/council', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: tx.id,
            judgeTier,
            forceRefresh: hasOldVerdict,
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
        setTimeout(() => {
          const chamberEl = document.getElementById('council-chamber');
          if (chamberEl) chamberEl.scrollIntoView({ behavior: 'smooth' });
        }, 250);
      }
      setSelectedRowIds([]);
    } catch (err) {
      console.error('Fejl under afvikling af rådskø:', err);
    } finally {
      setCouncilQueueRunning(false);
      setCouncilQueueProgress(null);
    }
  };

  // 3. Analyser alle uvurderede HIGH signaler automatisk
  const handleAnalyzeAllUnjudgedHigh = async () => {
    if (councilQueueRunning || loading || unjudgedHighCount === 0) return;

    setCouncilQueueRunning(true);
    setActiveTab('radar');
    let currentHistory = { ...verdictHistory };
    const completed: Array<{ tx: InsiderTransaction; verdict: CouncilVerdict }> = [];
    const failures: string[] = [];
    setCouncilError(null);

    try {
      for (let i = 0; i < unjudgedHighItems.length; i++) {
        const item = unjudgedHighItems[i];
        const tx = item.transaction;

        setCouncilQueueProgress({
          current: i + 1,
          total: unjudgedHighItems.length,
          ticker: tx.ticker,
          label: `Analyserer HIGH signal ${tx.ticker} (${i + 1}/${unjudgedHighItems.length})...`,
        });

        const res = await fetch('/api/council', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: tx.id,
            judgeTier,
            forceRefresh: false,
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
        setTimeout(() => {
          const chamberEl = document.getElementById('council-chamber');
          if (chamberEl) chamberEl.scrollIntoView({ behavior: 'smooth' });
        }, 250);
      }
    } catch (err) {
      console.error('Fejl under analyse af uvurderede HIGH signaler:', err);
    } finally {
      setCouncilQueueRunning(false);
      setCouncilQueueProgress(null);
    }
  };

  // KPI Beregninger
  const totalScanned = items.length;
  // Alle afviste: pipelinens rejected-liste + items, der ikke bestod hard-filteret (ældre gemte scans).
  const rejectedRows = collectRejected(scanRejected, items);
  const highAsymmetryCount = items.filter((i) => i.result.geminiPreScore >= 75).length;
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
                  v2.0-QUANT
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
                <span className="text-slate-400">GATEKEEPER{apiKeys.gatekeeperModel ? ` (${apiKeys.gatekeeperModel})` : ''}:</span>
                {(() => {
                  const keySet = apiKeys.gatekeeperProvider === 'gemini' ? apiKeys.gemini : apiKeys.anthropic;
                  return (
                    <span className={keySet ? 'text-emerald-400' : 'text-amber-400'}>
                      {keySet ? 'NØGLE SAT' : 'INGEN NØGLE · HEURISTIK'}
                    </span>
                  );
                })()}
                {gatekeeperUsage && gatekeeperUsage.calls > 0 && (
                  <span
                    className="text-slate-500"
                    title={`${gatekeeperUsage.inputTokens} input · ${gatekeeperUsage.cacheCreationInputTokens} cache-skriv · ${gatekeeperUsage.cacheReadInputTokens} cache-læs · ${gatekeeperUsage.outputTokens} output tokens · ${gatekeeperUsage.heuristicCount} heuristik · ${gatekeeperUsage.truncatedChunks} afskåret`}
                  >
                    · {gatekeeperUsage.calls} kald ·{' '}
                    {gatekeeperUsage.costUsd !== undefined ? `$${gatekeeperUsage.costUsd.toFixed(4)}` : 'pris ukendt'}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-900 border border-slate-800">
                <span className="h-2 w-2 rounded-full bg-cyan-500 animate-pulse" />
                <span className="text-slate-400">CLAUDE SONNET + OPUS:</span>
                <span className={apiKeys.anthropic ? 'text-cyan-400' : 'text-amber-400'}>
                  {apiKeys.anthropic ? 'NØGLE SAT' : 'INGEN NØGLE · RÅDET FEJLER'}
                </span>
              </div>
            </div>

            {/* 🌍 GLOBAL OMNI-SCANNER STATUS BADGE */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-cyan-800/80 bg-slate-900 shadow-sm text-xs font-mono">
              <span className="flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500"></span>
              </span>
              <span className="font-bold tracking-wider text-cyan-300">
                🌍 GLOBAL OMNI-SCANNER
              </span>
              <span className="text-[10px] text-slate-400 border-l border-slate-800 pl-2 hidden md:inline">
                US SEC + C-Suite + Nordic MAR 19
              </span>
            </div>

            {/* Scan Refresh Button */}
            <button
              onClick={() => {
                setActiveTickerQuery(null);
                fetchScan('unified', null);
              }}
              disabled={loading || autoPilotRunning}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-mono text-slate-200 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-cyan-400' : ''}`} />
              Scan Nu
            </button>
            <span className="text-[10px] font-mono text-slate-500" title="Tidspunkt for den viste scan">
              {scannedAt ? `Scannet ${formatDateTimeDk(scannedAt)}` : 'Ingen gemt scan'}
            </span>

            {/* 1. Send Valgte til Rådet Button */}
            <button
              onClick={handleRunCouncilOnSelected}
              disabled={loading || councilQueueRunning || selectedRowIds.length === 0}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded text-xs font-mono font-bold transition-all shadow-md ${
                councilQueueRunning
                  ? 'bg-amber-500/20 border border-amber-500/60 text-amber-300 shadow-amber-950 animate-pulse'
                  : selectedRowIds.length > 0
                  ? 'bg-gradient-to-r from-purple-800 to-cyan-700 hover:from-purple-700 hover:to-cyan-600 text-white border border-cyan-400 shadow-cyan-950 shadow-sm animate-pulse'
                  : 'bg-slate-800/80 border border-slate-700 text-slate-400 opacity-60 cursor-not-allowed'
              }`}
              title="Kør The Council på præcis de rækker der er krydset af i tabellen (gen-vurderer med frisk live-kurs hvis de har en gammel dom)"
            >
              <Scale className="w-3.5 h-3.5 text-cyan-400" />
              <span>⚖️ Send Valgte til Rådet ({selectedRowIds.length})</span>
            </button>

            {/* 2. Analyser Alle Uvurderede 'HIGH' Signaler */}
            <button
              onClick={handleAnalyzeAllUnjudgedHigh}
              disabled={loading || councilQueueRunning || unjudgedHighCount === 0}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded text-xs font-mono font-bold transition-all shadow-md ${
                councilQueueRunning
                  ? 'bg-slate-800 border border-slate-700 text-slate-400 opacity-60 cursor-not-allowed'
                  : unjudgedHighCount > 0
                  ? 'bg-emerald-950/90 hover:bg-emerald-900 border border-emerald-500/80 text-emerald-200 hover:text-white shadow-emerald-950'
                  : 'bg-slate-800/80 border border-slate-700 text-slate-400 opacity-60 cursor-not-allowed'
              }`}
              title="Finder alle aktier med asymmetrySignal === 'HIGH' eller score >= 75 der endnu ikke har en rådsdom"
            >
              <Zap className="w-3.5 h-3.5 text-emerald-400" />
              <span>⚡ Analyser Alle Uvurderede &apos;HIGH&apos; Signaler ({unjudgedHighCount})</span>
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
              {loading ? '-' : rejectedRows.length}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">0 tokens brugt på støj (afvist før scoring)</div>
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

            <button
              onClick={() => {
                setActiveTab('portfolio');
                handleRefreshPortfolioLivePnl();
              }}
              className={`px-4 py-2 font-mono text-xs font-bold tracking-wider border-b-2 transition-colors flex items-center gap-2 ${
                activeTab === 'portfolio'
                  ? 'border-emerald-400 text-emerald-300 bg-slate-900/40'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Briefcase className="w-3.5 h-3.5 text-emerald-400" />
              <span>💼 PAPER PORTEFØLJE & LIVE P&L</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-950 border border-emerald-800 text-emerald-300 font-bold">
                {Object.keys(paperPortfolio).length}
              </span>
            </button>
          </div>

          {activeTab === 'radar' && (
            <button
              onClick={() => setShowRejected(!showRejected)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 transition-colors text-xs font-mono"
            >
              {showRejected ? (
                <>
                  <EyeOff className="w-3.5 h-3.5 text-slate-400" />
                  <span>Skjul afvist støj ({rejectedRows.length})</span>
                </>
              ) : (
                <>
                  <Eye className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Vis afvist støj ({rejectedRows.length})</span>
                </>
              )}
            </button>
          )}
        </div>

        {activeTab === 'radar' && showRejected && <RejectedNoisePanel rows={rejectedRows} />}

        {/* Error message */}
        {error && (
          <div className="p-3 rounded bg-rose-950/40 border border-rose-800 text-rose-300 text-xs font-mono flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0" />
            <span className="whitespace-pre-line">{error}</span>
          </div>
        )}

        {/* Rådsfejl */}
        {councilError && (
          <div role="alert" className="p-3 rounded bg-rose-950/40 border border-rose-800 text-rose-300 text-xs font-mono flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
            <span className="flex-1">{councilError}</span>
            <button onClick={() => setCouncilError(null)} className="text-rose-400 hover:text-rose-200" aria-label="Luk fejlbesked">
              ✕
            </button>
          </div>
        )}

        {/* Council Queue Live Indicator Banner */}
        {councilQueueRunning && councilQueueProgress && (
          <div className="p-4 rounded bg-purple-950/80 border border-purple-500/80 text-purple-200 text-xs font-mono flex items-center justify-between gap-3 shadow-lg shadow-purple-950/40 animate-pulse">
            <div className="flex items-center gap-2.5">
              <RefreshCw className="w-4 h-4 text-cyan-400 animate-spin" />
              <div>
                <span className="font-bold text-amber-300">⚖️ RÅDS-KØ AKTIV: </span>
                <span>
                  {councilQueueProgress.label ||
                    `The Council voterer på $${councilQueueProgress.ticker} (${councilQueueProgress.current} af ${councilQueueProgress.total} kandidater)...`}
                </span>
              </div>
            </div>
            <div className="text-[11px] text-purple-300/80 hidden sm:block">
              Dual-Feed Live Kurs + Claude-specialister + CIO-dommer
            </div>
          </div>
        )}

        {/* TAB 1: RADAR TABLE & TOP PICKS HUB */}
        {activeTab === 'radar' && (
          <div className="space-y-6">
            {/* 🎯 RÅDETS AKTIVE KØBS-ANBEFALINGER (TOP PICKS) HUB */}
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 shadow-2xl backdrop-blur-sm">
              {/* Header & Filter Tabs */}
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-3.5 mb-4">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
                    <Target className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="font-mono text-sm sm:text-base font-bold text-slate-100 tracking-wider">
                        🎯 RÅDETS AKTIVE KØBS-ANBEFALINGER (TOP PICKS)
                      </h2>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-950/80 border border-emerald-700 text-emerald-300 font-bold">
                        {buyRecommendations.length} KØB
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 font-mono mt-0.5">
                      Filtreret til aktier godkendt af The Council med asymmetri og positiv risikoprofil
                    </p>
                  </div>
                </div>

                {/* Filter Tabs */}
                <div className="flex items-center rounded-lg border border-slate-800 bg-slate-950 p-1 text-xs font-mono self-stretch sm:self-auto overflow-x-auto">
                  <button
                    type="button"
                    onClick={() => setRecommendationFilterTab('BUY')}
                    className={`px-3 py-1.5 rounded-md transition-all flex items-center gap-1.5 font-bold whitespace-nowrap ${
                      recommendationFilterTab === 'BUY'
                        ? 'bg-emerald-950 border border-emerald-500 text-emerald-300 shadow-md shadow-emerald-950'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <span>🟢 Kun KØB-Anbefalinger ({buyRecommendations.length})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setRecommendationFilterTab('WATCH')}
                    className={`px-3 py-1.5 rounded-md transition-all flex items-center gap-1.5 font-bold whitespace-nowrap ${
                      recommendationFilterTab === 'WATCH'
                        ? 'bg-amber-950 border border-amber-500 text-amber-300 shadow-md shadow-amber-950'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <span>🟡 Overvåg / Afvent 60-74 ({watchRecommendations.length})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setRecommendationFilterTab('REJECTED')}
                    className={`px-3 py-1.5 rounded-md transition-all flex items-center gap-1.5 font-bold whitespace-nowrap ${
                      recommendationFilterTab === 'REJECTED'
                        ? 'bg-rose-950 border border-rose-700 text-rose-300 shadow-md shadow-rose-950'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <span>🔴 Afvist af Rådet &lt;60 ({rejectedRecommendations.length})</span>
                  </button>
                </div>
              </div>

              {/* Cards Grid */}
              {(() => {
                const activeList =
                  recommendationFilterTab === 'BUY'
                    ? buyRecommendations
                    : recommendationFilterTab === 'WATCH'
                    ? watchRecommendations
                    : rejectedRecommendations;

                if (activeList.length === 0) {
                  return (
                    <div className="py-8 text-center text-slate-400 font-mono text-xs border border-dashed border-slate-800 rounded-lg bg-slate-950/40">
                      {recommendationFilterTab === 'BUY' ? (
                        <div className="space-y-1">
                          <p className="font-bold text-slate-300">Ingen aktive købs-anbefalinger fra Rådet endnu</p>
                          <p className="text-[11px] text-slate-500">
                            Vælg interessante aktier fra radaren nedenfor med afkrydsning og klik &apos;Send Valgte til Rådet&apos;!
                          </p>
                        </div>
                      ) : recommendationFilterTab === 'WATCH' ? (
                        <div>Ingen aktier i overvågningskategorien (score 60-74).</div>
                      ) : (
                        <div>Ingen afviste aktier (score &lt;60).</div>
                      )}
                    </div>
                  );
                }

                return (
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {activeList.map(({ transaction: tx, verdict, savedAt }) => {
                      const plan = generateTradeExecutionPlan(tx, verdict, maxCapitalDkk, fxRates);
                      const isDkk = tx.ticker.endsWith('.CO') || tx.exchange?.includes('Copenhagen');
                      const isSek = tx.ticker.endsWith('.ST') || tx.exchange?.includes('Stockholm');
                      const currSym = isDkk ? 'DKK ' : isSek ? 'SEK ' : '$';
                      // Kun målte tal: ingen insiderkurs som stand-in for markedskursen og ingen afkast på tværs af valutaer.
                      const currentPrice = tx.currentMarketPrice;
                      const returnPct = tx.returnSinceBuyPct;
                      const isDiscount = returnPct !== undefined && returnPct < 0;
                      const evalTime = verdict.evaluatedAt || verdict.timestamp || savedAt;
                      const evalDateStr = formatDateTimeDk(evalTime);
                      const isInPortfolio = Boolean(paperPortfolio[tx.id]);
                      const isCardEvaluating = councilLoading && selectedTx?.id === tx.id;

                      const isBuy = verdict.asymmetryScore >= 75;
                      const isWatch = verdict.asymmetryScore >= 60 && verdict.asymmetryScore < 75;

                      return (
                        <div
                          key={`recom-${tx.id}`}
                          className={`rounded-lg p-4 flex flex-col justify-between transition-all border ${
                            isBuy
                              ? 'bg-gradient-to-b from-slate-900 via-slate-900/90 to-slate-950 border-emerald-500/40 hover:border-emerald-500/80 shadow-lg shadow-emerald-950/20'
                              : isWatch
                              ? 'bg-slate-900/90 border-amber-500/30 hover:border-amber-500/60 shadow-lg shadow-amber-950/10'
                              : 'bg-slate-900/60 border-rose-900/40 opacity-75 hover:opacity-100'
                          }`}
                        >
                          <div>
                            {/* Card Header: Flag + Ticker + Company + Score Badge */}
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <span className="text-xl shrink-0" title={getRegionBadge(tx.ticker, tx.exchange).label}>
                                  {getRegionBadge(tx.ticker, tx.exchange).flag}
                                </span>
                                <div>
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-mono font-bold text-base text-cyan-300 tracking-wider">
                                      {tx.ticker}
                                    </span>
                                    <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 border border-slate-700">
                                      {getRegionBadge(tx.ticker, tx.exchange).code}
                                    </span>
                                    {tx.exchange && (
                                      <span className="text-[10px] font-mono text-slate-400 hidden sm:inline">
                                        • {tx.exchange}
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-xs text-slate-200 font-sans font-medium line-clamp-1 max-w-[200px]" title={tx.companyName}>
                                    {tx.companyName}
                                  </div>
                                </div>
                              </div>

                              {/* Grønt KØB Badge eller Overvåg / Afvist */}
                              <div className="text-right shrink-0">
                                <span
                                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-mono font-bold border ${
                                    isBuy
                                      ? 'bg-emerald-950 border-emerald-500 text-emerald-300 shadow-sm shadow-emerald-900/50'
                                      : isWatch
                                      ? 'bg-amber-950 border-amber-500 text-amber-300'
                                      : 'bg-rose-950 border-rose-700 text-rose-300'
                                  }`}
                                >
                                  {isBuy ? '🟢 KØB' : isWatch ? '🟡 AFVENT' : '🔴 AFVIST'}{' '}
                                  ({verdict.previousScore && verdict.previousScore !== verdict.asymmetryScore ? `${verdict.previousScore} → ` : ''}
                                  {verdict.asymmetryScore}/100)
                                </span>
                              </div>
                            </div>

                            {/* CIO 1-line Headline */}
                            <p className="mt-2.5 text-xs font-sans text-slate-200 line-clamp-2 italic bg-slate-950/50 p-2.5 rounded border border-slate-800/80">
                              &ldquo;{verdict.headline}&rdquo;
                            </p>

                            {/* Pris & Timing vs. Vurdering */}
                            <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-1.5 text-xs font-mono">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-slate-400">Insider:</span>
                                <span className="text-slate-200 font-bold">{priceLabel(tx)}{tx.pricePerShare}</span>
                                <span className="text-slate-500">•</span>
                                <span className="text-slate-400">Nu:</span>
                                <span className="text-cyan-300 font-bold">{currentPrice !== undefined ? `${currSym}${currentPrice}` : 'mangler kurs'}</span>
                                {returnPct === undefined ? (
                                  <span className="text-slate-500 text-[10px]">afkast ukendt</span>
                                ) : isDiscount ? (
                                  <span className="px-1.5 py-0.5 rounded bg-emerald-950/90 border border-emerald-600/70 text-emerald-300 font-bold text-[10px]">
                                    💎 {Math.abs(returnPct).toFixed(1)}% under insider
                                  </span>
                                ) : (
                                  <span className="px-1.5 py-0.5 rounded bg-cyan-950/60 border border-cyan-800 text-cyan-300 text-[10px]">
                                    +{returnPct.toFixed(1)}% siden køb
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] text-slate-400">
                                Vurderet: <span className="text-slate-300">{evalDateStr}</span>
                              </div>
                            </div>

                            {/* Konkret Handels-Opskrift */}
                            <div className="mt-2.5">
                              {plan.status === 'ACTIVE_PLAN' ? (
                                <div className="p-2.5 rounded bg-cyan-950/30 border border-cyan-800/50 text-[11px] font-mono text-slate-200 leading-snug">
                                  <div className="text-[9px] uppercase tracking-wider text-cyan-400 font-bold mb-1 flex items-center gap-1">
                                    <Scale className="w-3 h-3" />
                                    <span>Konkret Handels-Opskrift</span>
                                  </div>
                                  <div>
                                    Forslag ({plan.recommendedAllocationDkk.toLocaleString('da-DK')} kr.): Køb{' '}
                                    <span className="font-bold text-white">{plan.totalShares} stk.</span> @ ~{currSym}{currentPrice} • Stop-Loss:{' '}
                                    <span className="text-rose-300 font-bold">{currSym}{plan.stopLossPrice}</span> ({plan.stopLossRiskPct}%) • Target:{' '}
                                    <span className="text-emerald-300 font-bold">{currSym}{plan.targetPrice1}</span> (+{plan.targetReturnPct1}%) • R/R 1:{plan.riskRewardRatio}
                                  </div>
                                </div>
                              ) : (
                                <div className="p-2 rounded bg-slate-950/40 border border-slate-800 text-[11px] font-mono text-slate-400">
                                  🛡️ Kapitalbeskyttelse: Rådet fraråder kapitalallokering.
                                </div>
                              )}
                            </div>
                          </div>

                          {/* 3 Hurtige Knapper på Kortet */}
                          <div className="mt-3.5 pt-2.5 border-t border-slate-800/80 grid grid-cols-3 gap-1.5 font-mono text-[11px]">
                            {/* 1. Åbn Fuld Analyse */}
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedTx(tx);
                                setActiveVerdict(verdict);
                                const chamberEl = document.getElementById('council-chamber');
                                if (chamberEl) chamberEl.scrollIntoView({ behavior: 'smooth' });
                              }}
                              className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center justify-center gap-1 text-center font-medium transition-colors"
                              title="Åbn fuld rådsanalyse, specialist-rapporter og memo"
                            >
                              <FileText className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                              <span className="truncate">📖 Analyse</span>
                            </button>

                            {/* 2. Gen-vurder i Rådet */}
                            <button
                              type="button"
                              onClick={() => handleConveneCouncil(tx, true)}
                              disabled={isCardEvaluating}
                              className="px-2 py-1.5 rounded bg-purple-950/60 hover:bg-purple-900/60 text-purple-200 border border-purple-700 flex items-center justify-center gap-1 text-center font-medium transition-colors disabled:opacity-50"
                              title="Hent frisk live-kurs og 14d ATR og kør gen-vurdering i Rådet"
                            >
                              <RefreshCw className={`w-3.5 h-3.5 text-purple-300 shrink-0 ${isCardEvaluating ? 'animate-spin' : ''}`} />
                              <span className="truncate">{isCardEvaluating ? 'Kører...' : '🔄 Gen-vurder'}</span>
                            </button>

                            {/* 3. Åbn Paper-Trade */}
                            {isInPortfolio ? (
                              <div className="px-2 py-1.5 rounded bg-emerald-950/90 border border-emerald-600 text-emerald-300 flex items-center justify-center gap-1 text-center font-bold text-[10px]">
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                <span className="truncate">✅ I Portefølje</span>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleOpenPaperTrade(tx, plan, verdict.asymmetryScore)}
                                disabled={portfolioLoading || plan.status !== 'ACTIVE_PLAN'}
                                className="px-2 py-1.5 rounded bg-gradient-to-r from-emerald-700 to-teal-700 hover:from-emerald-600 hover:to-teal-600 text-white font-bold flex items-center justify-center gap-1 text-center transition-all disabled:opacity-40"
                                title="Åbn paper-trade position med den foreslåede opskrift"
                              >
                                <Play className="w-3.5 h-3.5 text-emerald-200 shrink-0" />
                                <span className="truncate">📌 Paper-Trade</span>
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            {/* Radar-tabel container */}
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
                <button
                  onClick={() => setQuickFilter('below_insider')}
                  className={`px-3 py-1 rounded transition-colors flex items-center gap-1.5 ${
                    quickFilter === 'below_insider'
                      ? 'bg-blue-500/20 text-blue-300 font-bold border border-blue-500/40 shadow-sm shadow-blue-950'
                      : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                  }`}
                >
                  <span>💎 Under Insider Pris (Rabat-Zone)</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-blue-300">
                    {belowInsiderCount}
                  </span>
                </button>
                <button
                  onClick={() => setQuickFilter('csuite_cluster')}
                  className={`px-3 py-1 rounded transition-colors flex items-center gap-1.5 ${
                    quickFilter === 'csuite_cluster'
                      ? 'bg-purple-500/20 text-purple-300 font-bold border border-purple-500/40 shadow-sm shadow-purple-950'
                      : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                  }`}
                >
                  <span>🔥 C-Suite + Cluster Conviction</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-purple-300">
                    {csuiteClusterCount}
                  </span>
                </button>

                {/* Regions-filter (Client-side) */}
                <div className="flex flex-wrap items-center gap-1.5 border-l border-slate-800 pl-2.5 ml-1">
                  <span className="text-slate-500 text-[10px] font-semibold uppercase">REGION:</span>
                  <button
                    onClick={() => setRegionFilter('all')}
                    className={`px-2.5 py-1 rounded transition-colors flex items-center gap-1 text-[11px] ${
                      regionFilter === 'all'
                        ? 'bg-cyan-500/20 text-cyan-300 font-bold border border-cyan-500/40 shadow-sm'
                        : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                    }`}
                  >
                    <span>🌍 Alle Markeder</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-300">
                      {baseFiltered.length}
                    </span>
                  </button>
                  <button
                    onClick={() => setRegionFilter('us')}
                    className={`px-2.5 py-1 rounded transition-colors flex items-center gap-1 text-[11px] ${
                      regionFilter === 'us'
                        ? 'bg-blue-500/20 text-blue-300 font-bold border border-blue-500/40 shadow-sm'
                        : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                    }`}
                  >
                    <span>🇺🇸 USA (NYSE/NASDAQ)</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-blue-300">
                      {usCount}
                    </span>
                  </button>
                  <button
                    onClick={() => setRegionFilter('nordic')}
                    className={`px-2.5 py-1 rounded transition-colors flex items-center gap-1 text-[11px] ${
                      regionFilter === 'nordic'
                        ? 'bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/40 shadow-sm'
                        : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                    }`}
                  >
                    <span>🇩🇰🇸🇪 Norden (CPH/STO/HEL)</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-emerald-300">
                      {nordicCount}
                    </span>
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-3 text-[11px] text-slate-400">
                {selectedRowIds.length > 0 && (
                  <span className="text-cyan-300 font-bold px-2 py-0.5 rounded bg-cyan-950 border border-cyan-800">
                    {selectedRowIds.length} valgt til Rådet
                  </span>
                )}
                <span>
                  Viser <span className="text-cyan-300 font-bold">{filteredItems.length}</span> handler
                </span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs font-mono">
                <thead>
                  <tr className="bg-slate-900/80 border-b border-slate-800 text-slate-400 text-[11px]">
                    <th className="py-3 px-3 text-center w-10">
                      <input
                        type="checkbox"
                        checked={
                          filteredItems.length > 0 &&
                          filteredItems.every((item) => selectedRowIds.includes(item.transaction.id))
                        }
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedRowIds(filteredItems.map((i) => i.transaction.id));
                          } else {
                            setSelectedRowIds([]);
                          }
                        }}
                        className="rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-cyan-500/20 cursor-pointer"
                        title="Vælg alle viste handler"
                      />
                    </th>
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
                      <td colSpan={8} className="py-12 text-center text-slate-400">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <RefreshCw className="w-5 h-5 animate-spin text-cyan-400" />
                          <span>
                            {activeTickerQuery
                              ? `Slår CIK op og henter Form 4 filings for ${activeTickerQuery}...`
                              : 'Scanner SEC Form 4 filings og afvikler Gatekeeper...'}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ) : filteredItems.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-12 text-center text-slate-500">
                        Ingen transaktioner at vise.
                      </td>
                    </tr>
                  ) : (
                    filteredItems.map(({ transaction: tx, result: res }) => {
                      const isSelected = selectedTx?.id === tx.id;
                      const saved = verdictHistory[tx.id];
                      const isCouncilRejected = saved && saved.verdict.asymmetryScore < 60;
                      const isCFOorGC = /cfo|chief financial|general counsel|chief legal/i.test(
                        tx.insiderTitle
                      );
                      const isCosmeticBuy =
                        tx.transactionCode === 'P' && tx.holdingsIncreasePct !== undefined && tx.holdingsIncreasePct < 1.0;
                      const isChecked = selectedRowIds.includes(tx.id);

                      return (
                        <tr
                          key={tx.id}
                          className={`transition-colors ${
                            isSelected
                              ? 'bg-cyan-950/30'
                              : isCouncilRejected
                              ? 'bg-rose-950/15 opacity-65 hover:opacity-100'
                              : !res.passedHardFilter
                              ? 'bg-slate-950/60 opacity-60 hover:opacity-100'
                              : 'hover:bg-slate-900/60'
                          }`}
                        >
                          {/* Multi-Select Checkbox */}
                          <td className="py-3 px-3 text-center" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedRowIds((prev) => [...prev, tx.id]);
                                } else {
                                  setSelectedRowIds((prev) => prev.filter((id) => id !== tx.id));
                                }
                              }}
                              className="rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-cyan-500/20 cursor-pointer"
                              title={isChecked ? 'Fravælg række' : 'Vælg til Råds-kø'}
                            />
                          </td>
                          {/* Ticker & Company */}
                          <td className="py-3 px-3 font-semibold">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span
                                className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800/90 border border-slate-700 text-slate-300 font-mono inline-flex items-center gap-1 shrink-0"
                                title={getRegionBadge(tx.ticker, tx.exchange).label}
                              >
                                <span>{getRegionBadge(tx.ticker, tx.exchange).flag}</span>
                                <span className="font-bold text-[9px]">{getRegionBadge(tx.ticker, tx.exchange).code}</span>
                              </span>
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
                              ) : tx.isTradableInDK === true && tx.exchange ? (
                                <span
                                  className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800/90 border border-slate-700 text-slate-300 font-mono flex items-center gap-1"
                                  title={tx.tradabilityReason}
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
                              ) : (
                                <span
                                  className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800/60 border border-slate-600 text-slate-400 font-mono"
                                  title={tx.tradabilityReason || 'Handelbarhed ikke verificeret – data mangler'}
                                >
                                  ❔ Handelbarhed: mangler data{tx.exchange ? ` (${tx.exchange})` : ''}
                                </span>
                              )}
                            </div>
                            {/* Quick Broker / Chart Links */}
                            <div className="mt-1.5 flex items-center gap-1.5 text-[10px] font-mono">
                              <a
                                href={`https://finance.yahoo.com/quote/${encodeURIComponent(tx.ticker)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-slate-400 hover:text-cyan-300 transition-colors flex items-center gap-0.5"
                                title="Åbn chart og nøgletal på Yahoo Finance"
                              >
                                <span>📈 Yahoo</span>
                                <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                              </a>
                              <span className="text-slate-600">•</span>
                              <a
                                href={`https://www.nordnet.dk/markedet/aktiekurser?query=${encodeURIComponent(
                                  tx.ticker.replace(/\.(CO|ST)$/i, '')
                                )}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-slate-400 hover:text-emerald-300 transition-colors flex items-center gap-0.5"
                                title="Søg aktien på Nordnet"
                              >
                                <span>🔎 Nordnet</span>
                                <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                              </a>
                              {tx.secFilingUrl && (
                                <>
                                  <span className="text-slate-600">•</span>
                                  <a
                                    href={tx.secFilingUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-slate-400 hover:text-purple-300 transition-colors flex items-center gap-0.5"
                                    title="Åbn officiel indberetning"
                                  >
                                    <span>📄 Filing</span>
                                    <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                                  </a>
                                </>
                              )}
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
                              ) : tx.ownershipNature === 'D' ? (
                                <span
                                  className="text-[10px] px-1.5 py-0.2 rounded bg-slate-900 border border-slate-800 text-slate-400"
                                  title="Direkte personligt ejerskab"
                                >
                                  Direct
                                </span>
                              ) : null}
                              {tx.isClusterBuy && (
                                <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-950/60 border border-amber-800 text-amber-300 flex items-center gap-0.5">
                                  <Users className="w-2.5 h-2.5" />
                                  Cluster ({tx.clusterCount ?? 2})
                                </span>
                              )}
                              {(tx.offeringNote || tx.clusterBuyers?.some((b) => b.offeringNote)) && (
                                <span
                                  className="text-[10px] px-1.5 py-0.2 rounded bg-amber-950/60 border border-amber-700 text-amber-200"
                                  title={tx.offeringNote ?? tx.clusterBuyers?.find((b) => b.offeringNote)?.offeringNote}
                                >
                                  mulig deltagelse i udbud
                                </span>
                              )}
                              {tx.is10b51Plan && (
                                <span
                                  className="text-[10px] px-1.5 py-0.2 rounded bg-red-950/80 border border-red-700 text-red-300 font-semibold flex items-center gap-0.5"
                                  title="Handel gennemført via forudbestemt Rule 10b5-1 automatisk handelsplan (Lav asymmetri)"
                                >
                                  🤖 10b5-1 Auto-Plan
                                </span>
                              )}
                              {(() => {
                                const tr = tx.trackRecord || verdictHistory[tx.id]?.transaction.trackRecord;
                                if (!tr) return null;
                                if (tr.reputation === 'UNKNOWN') {
                                  return (
                                    <span
                                      className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800/60 border border-slate-600 text-slate-400 font-medium flex items-center gap-0.5"
                                      title={tr.reputationLabel}
                                    >
                                      ❔ Track record: mangler data
                                    </span>
                                  );
                                }
                                if (tr.reputation === 'SMART_MONEY_SNIPER') {
                                  return (
                                    <span
                                      className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-950/90 border border-emerald-500 text-emerald-300 font-bold flex items-center gap-0.5"
                                      title={tr.reputationLabel}
                                    >
                                      🎯 Sniper {tr.winRatePct}%
                                    </span>
                                  );
                                }
                                if (tr.reputation === 'EARLY_OR_BAGHOLDER') {
                                  return (
                                    <span
                                      className="text-[10px] px-1.5 py-0.2 rounded bg-rose-950/90 border border-rose-600 text-rose-300 font-bold flex items-center gap-0.5"
                                      title={tr.reputationLabel}
                                    >
                                      ⚠️ Bagholder
                                    </span>
                                  );
                                }
                                if (tr.reputation === 'FIRST_TIME_OR_RARE') {
                                  return (
                                    <span
                                      className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-950/80 border border-cyan-700 text-cyan-300 font-medium flex items-center gap-0.5"
                                      title={tr.reputationLabel}
                                    >
                                      🆕 1. gang
                                    </span>
                                  );
                                }
                                return (
                                  <span
                                    className="text-[10px] px-1.5 py-0.2 rounded bg-blue-950/80 border border-blue-700 text-blue-300 font-medium flex items-center gap-0.5"
                                    title={tr.reputationLabel}
                                  >
                                    📈 {tr.winRatePct}% Win
                                  </span>
                                );
                              })()}
                              {(() => {
                                const fund =
                                  tx.fundamentals ||
                                  verdictHistory[tx.id]?.transaction.fundamentals;
                                if (!fund) return null;
                                if (fund.fundamentalHealthBadge === 'UNKNOWN') {
                                  return (
                                    <span
                                      className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800/60 border border-slate-600 text-slate-400 font-medium flex items-center gap-0.5"
                                      title={fund.fundamentalSummary}
                                    >
                                      ❔ Balance: mangler data
                                    </span>
                                  );
                                }
                                if (fund.fundamentalHealthBadge === 'DILUTION_RISK') {
                                  return (
                                    <span
                                      className="text-[10px] px-1.5 py-0.2 rounded bg-rose-950/90 border border-rose-600 text-rose-300 font-bold flex items-center gap-0.5"
                                      title={fund.fundamentalSummary}
                                    >
                                      ⚠️ Runway &lt;9m
                                    </span>
                                  );
                                }
                                if (fund.fundamentalHealthBadge === 'SHORT_SQUEEZE_SETUP') {
                                  return (
                                    <span
                                      className="text-[10px] px-1.5 py-0.2 rounded bg-amber-950/90 border border-amber-500 text-amber-300 font-bold flex items-center gap-0.5"
                                      title={fund.fundamentalSummary}
                                    >
                                      🔥 Squeeze ({fund.shortPercentOfFloat?.toFixed(1)}% Short)
                                    </span>
                                  );
                                }
                                if (fund.fundamentalHealthBadge === 'FORTRESS_BALANCE') {
                                  return (
                                    <span
                                      className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-950/90 border border-emerald-500 text-emerald-300 font-bold flex items-center gap-0.5"
                                      title={fund.fundamentalSummary}
                                    >
                                      🏰 Fortress Cash
                                    </span>
                                  );
                                }
                                if (fund.fundamentalHealthBadge === 'SOLID_RUNWAY') {
                                  return (
                                    <span
                                      className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-950/80 border border-cyan-600 text-cyan-300 font-medium flex items-center gap-0.5"
                                      title={fund.fundamentalSummary}
                                    >
                                      📈 Solid Runway
                                    </span>
                                  );
                                }
                                return null;
                              })()}
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
                              {tx.shares.toLocaleString()} stk a {priceLabel(tx)}{tx.pricePerShare}
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
                                (tx.holdingsIncreasePct ?? 0) >= 15
                                  ? 'text-emerald-400'
                                  : isCosmeticBuy
                                  ? 'text-amber-400'
                                  : 'text-slate-300'
                              }`}
                            >
                              {tx.holdingsIncreasePct === undefined ? (
                                <span className="text-slate-500" title="Beholdning ikke oplyst eller ny position">ukendt</span>
                              ) : (
                                <>
                                  {tx.holdingsIncreasePct > 0 ? (
                                    <TrendingUp className="w-3 h-3" />
                                  ) : (
                                    <TrendingDown className="w-3 h-3" />
                                  )}
                                  {tx.holdingsIncreasePct > 0 ? '+' : ''}
                                  {tx.holdingsIncreasePct}%
                                </>
                              )}
                            </div>
                            {isCosmeticBuy && (
                              <div className="text-[10px] text-amber-400/80 font-sans">
                                Kosmetisk PR-køb
                              </div>
                            )}
                          </td>

                          {/* Gatekeeper Pre-Score & Saved Council Verdict */}
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
                                    {!isModelScore(res) && (
                                      <span className="ml-1 font-normal opacity-75" title="Heuristisk score (gatekeeper-modellen svarede ikke) – starter ikke auto-køen">
                                        · heuristik
                                      </span>
                                    )}
                                  </span>

                                  {/* Badge hvis der allerede findes en afsagt dom - Ultra-tydelig farvekodning */}
                                  {saved && (
                                    <span
                                      className={`px-2 py-0.5 rounded text-[10px] font-bold border flex items-center gap-1 ${
                                        saved.verdict.asymmetryScore >= 75
                                          ? 'bg-emerald-950 border-emerald-500 text-emerald-300 shadow-sm shadow-emerald-950'
                                          : saved.verdict.asymmetryScore >= 60
                                          ? 'bg-amber-950 border-amber-600 text-amber-300'
                                          : 'bg-rose-950 border-rose-700 text-rose-300'
                                      }`}
                                    >
                                      {saved.verdict.asymmetryScore >= 75
                                        ? `🟢 ANBEFALET KØB (${saved.verdict.asymmetryScore}/100)`
                                        : saved.verdict.asymmetryScore >= 60
                                        ? `🟡 AFVENT / OVERVÅG (${saved.verdict.asymmetryScore}/100)`
                                        : `🔴 AFVIST (${saved.verdict.asymmetryScore}/100)`}
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

                          {/* Action Buttons */}
                          <td className="py-3 px-3 text-right">
                            {res.passedHardFilter ? (
                              <div className="flex items-center justify-end gap-1.5">
                                {saved ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSelectedTx(tx);
                                        setActiveVerdict(saved.verdict);
                                        const chamberEl = document.getElementById('council-chamber');
                                        if (chamberEl) chamberEl.scrollIntoView({ behavior: 'smooth' });
                                      }}
                                      className={`px-2.5 py-1.5 rounded text-xs font-mono font-bold transition-all flex items-center gap-1 border ${
                                        saved.verdict.asymmetryScore >= 75
                                          ? 'bg-emerald-950/80 border-emerald-500 text-emerald-300 hover:bg-emerald-900 shadow-sm shadow-emerald-950'
                                          : saved.verdict.asymmetryScore >= 60
                                          ? 'bg-amber-950/80 border-amber-600 text-amber-300 hover:bg-amber-900'
                                          : 'bg-rose-950/80 border-rose-700 text-rose-300 hover:bg-rose-900'
                                      }`}
                                      title="Åbn afsagt rådsdom i The Council Chamber"
                                    >
                                      <Eye className="w-3.5 h-3.5" />
                                      <span>Vis Dom ({saved.verdict.asymmetryScore}/100)</span>
                                    </button>

                                    <button
                                      type="button"
                                      onClick={() => handleConveneCouncil(tx, true)}
                                      disabled={councilLoading && isSelected}
                                      className="p-1.5 rounded bg-slate-800 hover:bg-purple-950/80 hover:border-purple-600 border border-slate-700 text-slate-300 hover:text-purple-200 transition-all disabled:opacity-50"
                                      title="Gen-vurder aktien i Rådet med frisk live kurs og ATR"
                                    >
                                      <RefreshCw
                                        className={`w-3.5 h-3.5 ${
                                          councilLoading && isSelected
                                            ? 'animate-spin text-purple-400'
                                            : 'text-slate-400'
                                        }`}
                                      />
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => handleConveneCouncil(tx, false)}
                                    disabled={councilLoading && isSelected}
                                    className={`px-3 py-1.5 rounded text-xs font-mono font-medium transition-all flex items-center gap-1.5 ${
                                      isSelected
                                        ? 'bg-cyan-500 text-slate-950 shadow-lg shadow-cyan-500/20 font-bold'
                                        : 'bg-slate-800 hover:bg-cyan-950/80 hover:text-cyan-300 border border-slate-700 text-slate-200'
                                    }`}
                                  >
                                    {councilLoading && isSelected ? (
                                      <>
                                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                        <span>Rådet tænker...</span>
                                      </>
                                    ) : (
                                      <>
                                        <Scale className="w-3.5 h-3.5 text-cyan-400" />
                                        <span>Saml Rådet</span>
                                      </>
                                    )}
                                  </button>
                                )}
                              </div>
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
                            {tx.insiderName} ({tx.insiderTitle}) • ${Math.round(tx.totalValueUsd).toLocaleString()} ({tx.holdingsIncreasePct !== undefined ? `+${tx.holdingsIncreasePct}%` : 'beholdning ukendt'})
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
                          {tx.is10b51Plan && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-red-950/80 border border-red-700 text-red-300 font-mono">
                              🤖 10b5-1 Plan
                            </span>
                          )}
                        </div>
                        {tx.currentMarketPrice !== undefined && (
                          <div className="flex items-center gap-1.5 font-mono text-[11px]">
                            <span className="text-slate-400">
                              Købt @ {priceLabel(tx)}{tx.pricePerShare} → Nu: <span className="text-slate-200 font-medium">{marketPriceLabel(tx.ticker)}{tx.currentMarketPrice}</span>
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

        {/* TAB 3: PAPER PORTEFØLJE & LIVE P&L */}
        {activeTab === 'portfolio' && (
          <div className="space-y-6">
            {/* Top Portfolio KPI-Bar – én række pr. handelstype (PAPER altid, REAL_NORDNET når der er positioner) */}
            {(['PAPER', 'REAL_NORDNET'] as const)
              .filter((t) => t === 'PAPER' || (portfolioSummaries[t] && portfolioSummaries[t]!.openCount + portfolioSummaries[t]!.closedCount > 0))
              .map((kpiType, kpiIdx) => {
                const portfolioSummary = portfolioSummaries[kpiType];
                return (
            <div key={kpiType} className="space-y-1.5">
            <div className="text-[11px] font-mono font-bold text-slate-400 uppercase">
              {kpiType === 'PAPER' ? '🧪 Paper-trades' : '🏦 Rigtige Nordnet-positioner'}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
              {/* Card 1: Samlet Investeret */}
              <div className="bg-slate-900/70 border border-slate-800 p-4 rounded-lg space-y-1">
                <div className="flex items-center justify-between text-slate-400 text-xs font-mono">
                  <span>SAMLET INVESTERET</span>
                  <Briefcase className="w-4 h-4 text-emerald-400" />
                </div>
                <div className="text-2xl font-mono font-bold text-slate-100">
                  {(portfolioSummary?.totalInvestedDkk || 0).toLocaleString('da-DK')} DKK
                </div>
                <div className="text-[11px] text-slate-500 font-mono">
                  {portfolioSummary?.openCount || 0} aktive positioner
                </div>
              </div>

              {/* Card 2: Aktuel Markedsværdi */}
              <div className="bg-slate-900/70 border border-slate-800 p-4 rounded-lg space-y-1">
                <div className="flex items-center justify-between text-slate-400 text-xs font-mono">
                  <span>AKTUEL MARKEDSVÆRDI</span>
                  <Zap className="w-4 h-4 text-cyan-400" />
                </div>
                <div className="text-2xl font-mono font-bold text-cyan-300">
                  {(portfolioSummary?.totalCurrentValueDkk || 0).toLocaleString('da-DK')} DKK
                </div>
                <div className="text-[11px] text-slate-500 font-mono">
                  Realtid CNBC + Yahoo kurser
                </div>
              </div>

              {/* Card 3: Samlet P&L */}
              <div className="bg-slate-900/70 border border-slate-800 p-4 rounded-lg space-y-1">
                <div className="flex items-center justify-between text-slate-400 text-xs font-mono">
                  <span>P&L (REAL. + UREAL.)</span>
                  {(portfolioSummary?.totalPnlDkk || 0) >= 0 ? (
                    <TrendingUp className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <TrendingDown className="w-4 h-4 text-rose-400" />
                  )}
                </div>
                <div
                  className={`text-2xl font-mono font-bold ${
                    (portfolioSummary?.totalPnlDkk || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {(portfolioSummary?.totalPnlDkk || 0) >= 0 ? '+' : ''}
                  {(portfolioSummary?.totalPnlDkk || 0).toLocaleString('da-DK')} DKK
                </div>
                <div
                  className={`text-[11px] font-mono font-bold ${
                    (portfolioSummary?.totalPnlPct || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {(portfolioSummary?.totalPnlPct || 0) >= 0 ? '+' : ''}
                  {portfolioSummary?.totalPnlPct || 0}% afkast
                </div>
              </div>

              {/* Card 4: Netto Alpha vs. S&P 500 (SPY) */}
              <div className="bg-slate-900/70 border border-slate-800 p-4 rounded-lg space-y-1">
                <div className="flex items-center justify-between text-slate-400 text-xs font-mono">
                  <span>ALPHA VS. S&P 500</span>
                  <Flame className="w-4 h-4 text-amber-400" />
                </div>
                {typeof portfolioSummary?.avgAlphaPct === 'number' ? (
                  <div
                    className={`text-2xl font-mono font-bold ${
                      portfolioSummary.avgAlphaPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {portfolioSummary.avgAlphaPct >= 0 ? '+' : ''}
                    {portfolioSummary.avgAlphaPct}% Alpha
                  </div>
                ) : (
                  <div className="text-2xl font-mono font-bold text-slate-500">N/A</div>
                )}
                <div className="text-[11px] text-slate-500 font-mono">
                  SPY i DKK i perioden:{' '}
                  {typeof portfolioSummary?.benchmarkReturnPct === 'number'
                    ? `${portfolioSummary.benchmarkReturnPct >= 0 ? '+' : ''}${portfolioSummary.benchmarkReturnPct}%`
                    : 'N/A'}
                </div>
              </div>

              {/* Card 5: Win-Rate & Refresh Button */}
              <div className="bg-slate-900/70 border border-slate-800 p-4 rounded-lg flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between text-slate-400 text-xs font-mono">
                    <span>WIN-RATE (LUKKEDE)</span>
                    <Target className="w-4 h-4 text-amber-400" />
                  </div>
                  <div className="text-2xl font-mono font-bold text-amber-300 mt-1">
                    {typeof portfolioSummary?.winRatePct === 'number' ? `${portfolioSummary.winRatePct}%` : 'N/A'}
                  </div>
                  <div className="text-[11px] text-slate-500 font-mono">
                    {portfolioSummary?.closedCount ?? 0} lukkede • realiseret {(portfolioSummary?.realizedPnlDkk ?? 0).toLocaleString('da-DK')} DKK
                  </div>
                </div>
                {kpiIdx === 0 && (
                <button
                  onClick={handleRefreshPortfolioLivePnl}
                  disabled={portfolioRefreshing}
                  className="mt-2 w-full py-1.5 px-3 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50 border border-slate-700 text-xs font-mono text-cyan-300 flex items-center justify-center gap-1.5 transition-colors"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${portfolioRefreshing ? 'animate-spin' : ''}`} />
                  <span>{portfolioRefreshing ? 'Henter kurser & radar...' : 'Opdatér Live P&L'}</span>
                </button>
                )}
              </div>
            </div>
            </div>
                );
              })}

            {/* Position List / Cards */}
            {Object.keys(paperPortfolio).length === 0 ? (
              <div className="p-8 rounded-lg bg-slate-900/40 border border-slate-800 text-center space-y-3">
                <div className="w-12 h-12 rounded-full bg-emerald-950/60 border border-emerald-800/80 flex items-center justify-center mx-auto text-emerald-400">
                  <Briefcase className="w-6 h-6" />
                </div>
                <h4 className="font-mono text-sm font-bold text-slate-200">
                  INGEN ÅBNE PAPER-TRADES ENDNU
                </h4>
                <p className="text-xs text-slate-400 max-w-lg mx-auto font-sans leading-relaxed">
                  Start med at scanne Form 4 indberetninger i <span className="font-mono text-cyan-400">RADAR SCAN</span>, lad <span className="font-mono text-purple-400">The Council</span> afsige dom over en asymmetrisk case, og klik derefter på <span className="font-mono text-emerald-400">📌 Åbn Paper-Trade</span> i eksekveringsplanen for at tracke positionen her.
                </p>
                <button
                  onClick={() => setActiveTab('radar')}
                  className="px-4 py-2 rounded bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-mono text-xs font-bold transition-colors inline-flex items-center gap-2"
                >
                  <Activity className="w-3.5 h-3.5" />
                  Gå til Radar Scan
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                {Object.values(paperPortfolio).map((pos) => {
                  const isDkk = pos.ticker.endsWith('.CO') || pos.exchange?.includes('Copenhagen');
                  const isSek = pos.ticker.endsWith('.ST') || pos.exchange?.includes('Stockholm');
                  const currSym = isDkk ? 'DKK ' : isSek ? 'SEK ' : '$';
                  const currencyCode = isDkk ? 'DKK' : isSek ? 'SEK' : 'USD';

                  // Beregn Stop-Loss -> Entry -> Target visuel progress-bar
                  const minP = pos.stopLossPrice > 0 ? pos.stopLossPrice : pos.entryPrice * 0.85;
                  const maxP = pos.targetPrice > 0 ? pos.targetPrice : pos.entryPrice * 1.5;
                  const span = Math.max(0.01, maxP - minP);
                  const currPct = Math.min(100, Math.max(0, ((pos.currentPrice - minP) / span) * 100));
                  const entryPct = Math.min(100, Math.max(0, ((pos.entryPrice - minP) / span) * 100));

                  const isProfit = pos.pnlDkk >= 0;
                  const isBelowInsider =
                    typeof pos.insiderBuyPrice === 'number' &&
                    pos.insiderBuyPrice > 0 &&
                    pos.currentPrice < pos.insiderBuyPrice;

                  const nordnetUrl = isDkk
                    ? `https://www.nordnet.dk/markedet/aktier/${encodeURIComponent(pos.ticker)}`
                    : `https://www.nordnet.dk/markedet/aktier?query=${encodeURIComponent(pos.ticker)}`;
                  const yahooUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(pos.ticker)}`;

                  return (
                    <div
                      key={pos.id}
                      className="p-4 rounded-lg bg-slate-900/80 border border-slate-800 shadow-xl space-y-4 hover:border-slate-700 transition-colors"
                    >
                      {/* Position Header */}
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-base font-bold text-white tracking-wider">
                            ${pos.ticker}
                          </span>
                          <span className="text-xs text-slate-300 font-medium">
                            {pos.companyName}
                          </span>
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-300 border border-slate-700">
                            {pos.exchange}
                          </span>
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-cyan-950 border border-cyan-800 text-cyan-300">
                            Score ved åbning: {pos.openedScore ?? pos.asymmetryScore}/100
                          </span>
                          <PositionVerdict
                            openedScore={pos.openedScore ?? pos.asymmetryScore}
                            latest={latestValidatedVerdict(verdictHistory, pos.ticker)}
                          />
                        </div>

                        <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
                          {pos.tradeType === 'REAL_NORDNET' ? (
                            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-950/90 border border-amber-500 text-amber-300 shadow-sm shadow-amber-950">
                              🏦 NORDNET LIVE HANDEL
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-cyan-950/80 border border-cyan-700 text-cyan-300">
                              🧪 PAPER-TRADE
                            </span>
                          )}

                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border ${
                              pos.status === 'STOPPED_OUT'
                                ? 'bg-rose-950/80 border-rose-700 text-rose-300'
                                : pos.status === 'TARGET_HIT'
                                ? 'bg-purple-950/80 border-purple-700 text-purple-300'
                                : 'bg-emerald-950/80 border-emerald-700 text-emerald-300'
                            }`}
                          >
                            {pos.status === 'OPEN'
                              ? 'AKTIV POSITION'
                              : pos.status === 'STOPPED_OUT'
                              ? '🛑 STOP-LOSS UDLØST'
                              : pos.status === 'TARGET_HIT'
                              ? '🎯 KURSMÅL NÅET'
                              : 'LUKKET'}
                          </span>

                          {pos.priceAlert && (
                            <span
                              className="px-2 py-0.5 rounded text-[10px] font-mono font-bold border bg-amber-950/80 border-amber-500 text-amber-200"
                              title="Rigtig position: status ændres ikke automatisk – handl selv på Nordnet"
                            >
                              {pos.priceAlert === 'STOP' ? '⚠️ KURSEN ER UNDER DIT STOP' : '⚠️ KURSMÅL NÅET – OVERVEJ SALG'}
                            </span>
                          )}

                          <button
                            onClick={() => (editingPosId === pos.id ? setEditingPosId(null) : handleStartEdit(pos))}
                            className="px-2.5 py-1 rounded bg-slate-800 hover:bg-cyan-950 hover:text-cyan-300 hover:border-cyan-700 border border-slate-700 text-slate-300 text-xs font-mono transition-colors flex items-center gap-1"
                            title="Redigér position for at matche din reelle Nordnet handel"
                          >
                            <Edit3 className="w-3 h-3 text-cyan-400" />
                            <span>{editingPosId === pos.id ? 'Luk Redigering' : 'Redigér / Nordnet Match'}</span>
                          </button>

                          <button
                            onClick={() => handleClosePaperTrade(pos.id)}
                            className="px-2.5 py-1 rounded bg-slate-800 hover:bg-rose-950 hover:text-rose-300 hover:border-rose-800 border border-slate-700 text-slate-400 text-xs font-mono transition-colors flex items-center gap-1"
                            title="Luk og fjern position"
                          >
                            <Trash2 className="w-3 h-3" />
                            <span>Luk Position</span>
                          </button>
                        </div>
                      </div>

                      {/* 4 Metrics Grid: Adskilt for 100% transparens */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono">
                        {/* 1. Din Entry vs Live Børskurs -> Dit Faktiske Afkast */}
                        <div
                          className={`p-3 rounded border space-y-1.5 ${
                            isProfit
                              ? 'bg-emerald-950/25 border-emerald-900/60'
                              : 'bg-rose-950/25 border-rose-900/60'
                          }`}
                        >
                          <div className="flex items-center justify-between text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                            <span>1. DIT FAKTISKE AFKAST</span>
                            {isProfit ? (
                              <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <TrendingDown className="w-3.5 h-3.5 text-rose-400" />
                            )}
                          </div>
                          <div className="text-[11px] text-slate-300">
                            Entry: <span className="font-semibold text-slate-100">{currSym}{pos.entryPrice}</span>
                            <span className="text-slate-500 mx-1">→</span>
                            Nu: <span className="font-bold text-white">{currSym}{pos.currentPrice}</span>
                          </div>
                          <div className="pt-1 border-t border-slate-800/60">
                            <div className={`text-base font-bold ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {isProfit ? '+' : ''}{pos.pnlPct}%
                              <span className="text-xs font-medium ml-1.5 opacity-90">
                                ({isProfit ? '+' : ''}{pos.pnlDkk.toLocaleString('da-DK')} DKK)
                              </span>
                            </div>
                            <div className="pt-1 mt-1 border-t border-slate-800/60 flex items-center justify-between text-[11px]">
                              <span className="text-slate-400 flex items-center gap-0.5">
                                <Zap className="w-3 h-3 text-amber-400" /> Alpha:
                              </span>
                              {typeof pos.alphaPct === 'number' ? (
                                <span className={`font-bold ${pos.alphaPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                  {pos.alphaPct >= 0 ? '+' : ''}
                                  {pos.alphaPct}%
                                  <span className="text-[10px] font-normal text-slate-400 ml-1">
                                    (SPY i DKK: {typeof pos.benchmarkReturnPct === 'number' ? `${pos.benchmarkReturnPct >= 0 ? '+' : ''}${pos.benchmarkReturnPct}%` : 'N/A'})
                                  </span>
                                </span>
                              ) : (
                                <span className="font-bold text-slate-500" title="SPY-kurs eller USD/DKK ved entry mangler">N/A</span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* 2. Insiderens Købskurs vs Live Kurs */}
                        <div className="p-3 rounded bg-slate-950/60 border border-slate-800/80 space-y-1.5">
                          <div className="flex items-center justify-between text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                            <span>2. INSIDER ALPHA</span>
                            <UserCheck className="w-3.5 h-3.5 text-amber-400" />
                          </div>
                          <div className="text-[11px] text-slate-300">
                            Insider: <span className="font-semibold text-amber-300">{currSym}{pos.insiderBuyPrice || pos.entryPrice}</span>
                          </div>
                          <div className="text-[11px] text-slate-400 truncate" title={`${pos.insiderName} (${pos.insiderTitle})`}>
                            {pos.insiderName} ({pos.insiderTitle})
                          </div>
                          <div className="pt-1 border-t border-slate-800/60 flex items-center justify-between">
                            <span className="text-[10px] text-slate-400">Insider P&L:</span>
                            {Number.isFinite(pos.insiderPnlPct) ? (
                              <span className={`text-[11px] font-bold ${pos.insiderPnlPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {pos.insiderPnlPct >= 0 ? '+' : ''}{pos.insiderPnlPct}%
                              </span>
                            ) : (
                              <span className={`text-[11px] ${TONE_CLASS.unknown}`}>N/A</span>
                            )}
                          </div>
                          {isBelowInsider && (
                            <div className="text-[10px] text-emerald-400 font-semibold bg-emerald-950/40 border border-emerald-900/50 rounded px-1.5 py-0.5 text-center">
                              🔥 Rabat ift. insider
                            </div>
                          )}
                        </div>

                        {/* 3. Position & Allokering */}
                        <div className="p-3 rounded bg-slate-950/60 border border-slate-800/80 space-y-1.5">
                          <div className="flex items-center justify-between text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                            <span>3. ALLOKERING</span>
                            <Briefcase className="w-3.5 h-3.5 text-cyan-400" />
                          </div>
                          <div className="text-sm font-bold text-slate-200">
                            {pos.shares} aktier
                          </div>
                          <div className="text-xs text-slate-300 font-semibold">
                            {pos.investedDkk.toLocaleString('da-DK')} DKK inv.
                          </div>
                          <div className="pt-1 border-t border-slate-800/60 text-[10px] text-slate-400">
                            Værdi nu: <span className="text-cyan-300 font-bold">{pos.currentFxRateDkk > 0 ? `${Math.round(pos.shares * pos.currentPrice * pos.currentFxRateDkk).toLocaleString('da-DK')} DKK` : 'mangler valutakurs'}</span>
                          </div>
                        </div>

                        {/* 4. Stop-Loss & Target */}
                        <div className="p-3 rounded bg-slate-950/60 border border-slate-800/80 space-y-1.5">
                          <div className="flex items-center justify-between text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                            <span>4. RISIKO & MÅL</span>
                            <Target className="w-3.5 h-3.5 text-purple-400" />
                          </div>
                          <div className="text-rose-400 text-xs">
                            Stop: <span className="font-bold">{currSym}{pos.stopLossPrice}</span>
                          </div>
                          <div className="text-emerald-400 text-xs">
                            Mål: <span className="font-bold">{currSym}{pos.targetPrice}</span>
                          </div>
                          <div className="pt-1 border-t border-slate-800/60 text-[10px] text-slate-500">
                            Åbnet: {new Date(pos.openedAt).toLocaleDateString('da-DK')}
                          </div>
                        </div>
                      </div>

                      {/* Insider-Exit Guard Status */}
                      {pos.insiderExitWarning?.hasExit ? (
                        <div className="p-2.5 rounded bg-rose-950/80 border border-rose-500 text-rose-200 text-xs font-mono flex items-center justify-between gap-2 shadow-lg shadow-rose-950/50 animate-pulse">
                          <div className="flex items-center gap-2">
                            <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
                            <div>
                              <span className="font-bold text-rose-100">🚨 INSIDER-EXIT DETEKTERET: </span>
                              <span>{pos.insiderExitWarning.message}</span>
                            </div>
                          </div>
                          <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-rose-900 border border-rose-700 text-rose-200 shrink-0">
                            Exit Alarm
                          </span>
                        </div>
                      ) : (
                        // "Ikke tjekket", fejl og "0 salg" er forskellige tilstande – kun NO_SALES er grøn.
                        <div className="px-3 py-1.5 rounded bg-slate-950/50 border border-slate-800/80 flex items-center justify-between text-[11px] font-mono text-slate-400 gap-2">
                          {pos.insiderExitWarning?.status === 'NO_SALES' ? (
                            <div className="flex items-center gap-1.5 text-emerald-400">
                              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                              <span>🛡️ Exit-Radar: {pos.insiderExitWarning.message}</span>
                            </div>
                          ) : pos.insiderExitWarning?.status === 'SALES_FOUND' ? (
                            <div className="flex items-center gap-1.5 text-slate-300">
                              <ShieldCheck className="w-3.5 h-3.5 text-slate-400" />
                              <span>Exit-Radar: kun planlagte salg/10 %-ejere – {pos.insiderExitWarning.message}</span>
                            </div>
                          ) : pos.insiderExitWarning?.status === 'ERROR' ? (
                            <div className="flex items-center gap-1.5 text-rose-300">
                              <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
                              <span>{pos.insiderExitWarning.message}</span>
                            </div>
                          ) : pos.insiderExitWarning?.status === 'UNSUPPORTED' ? (
                            <div className="flex items-center gap-1.5 text-slate-400">
                              <span>Exit-Radar: {pos.insiderExitWarning.message}</span>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5 text-amber-300">
                              <span>Exit-Radar: ikke tjekket endnu – tryk &quot;Opdatér Live P&amp;L&quot;</span>
                            </div>
                          )}
                          {pos.insiderExitWarning?.checkedAt && (
                            <span className="text-[10px] text-slate-500 shrink-0">Tjekket {formatDateTimeDk(pos.insiderExitWarning.checkedAt)}</span>
                          )}
                        </div>
                      )}

                      {/* Inline Formular for Redigering (Nordnet Match) */}
                      {editingPosId === pos.id && (
                        <div className="p-4 rounded-lg bg-slate-950 border border-cyan-800/80 shadow-2xl space-y-3 font-mono">
                          <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                            <div className="flex items-center gap-2">
                              <Edit3 className="w-4 h-4 text-cyan-400" />
                              <span className="text-xs font-bold text-cyan-300 uppercase tracking-wider">
                                Manuel Redigering & Nordnet Match for ${pos.ticker}
                              </span>
                            </div>
                            <span className="text-[10px] text-slate-400">Opdaterer straks investering og P&L</span>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3 text-xs">
                            {/* Trade Type */}
                            <div className="space-y-1">
                              <label className="text-[10px] text-slate-400 uppercase">Handelstype</label>
                              <select
                                value={editForm.tradeType}
                                onChange={(e) =>
                                  setEditForm((prev) => ({
                                    ...prev,
                                    tradeType: e.target.value as 'PAPER' | 'REAL_NORDNET',
                                  }))
                                }
                                className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-slate-100 font-bold focus:border-cyan-500 focus:outline-none"
                              >
                                <option value="PAPER">🧪 Paper-Trade</option>
                                <option value="REAL_NORDNET">🏦 Nordnet Live</option>
                              </select>
                            </div>

                            {/* Entry Price */}
                            <div className="space-y-1">
                              <label className="text-[10px] text-slate-400 uppercase">Min Købskurs ({currSym.trim()})</label>
                              <input
                                type="number"
                                step="any"
                                value={editForm.entryPrice}
                                onChange={(e) =>
                                  setEditForm((prev) => ({ ...prev, entryPrice: parseFloat(e.target.value) || 0 }))
                                }
                                className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-slate-100 focus:border-cyan-500 focus:outline-none"
                              />
                            </div>

                            {/* Shares */}
                            <div className="space-y-1">
                              <label className="text-[10px] text-slate-400 uppercase">Antal Aktier</label>
                              <input
                                type="number"
                                step="1"
                                value={editForm.shares}
                                onChange={(e) =>
                                  setEditForm((prev) => ({ ...prev, shares: parseInt(e.target.value, 10) || 0 }))
                                }
                                className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-slate-100 focus:border-cyan-500 focus:outline-none"
                              />
                            </div>

                            {/* Stop Loss */}
                            <div className="space-y-1">
                              <label className="text-[10px] text-rose-400 uppercase">Stop-Loss ({currSym.trim()})</label>
                              <input
                                type="number"
                                step="any"
                                value={editForm.stopLossPrice}
                                onChange={(e) =>
                                  setEditForm((prev) => ({ ...prev, stopLossPrice: parseFloat(e.target.value) || 0 }))
                                }
                                className="w-full bg-slate-900 border border-rose-900/60 rounded px-2.5 py-1.5 text-rose-300 focus:border-rose-500 focus:outline-none"
                              />
                            </div>

                            {/* Target Price */}
                            <div className="space-y-1">
                              <label className="text-[10px] text-emerald-400 uppercase">Kursmål ({currSym.trim()})</label>
                              <input
                                type="number"
                                step="any"
                                value={editForm.targetPrice}
                                onChange={(e) =>
                                  setEditForm((prev) => ({ ...prev, targetPrice: parseFloat(e.target.value) || 0 }))
                                }
                                className="w-full bg-slate-900 border border-emerald-900/60 rounded px-2.5 py-1.5 text-emerald-300 focus:border-emerald-500 focus:outline-none"
                              />
                            </div>
                          </div>

                          {/* Edit Actions */}
                          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
                            <button
                              type="button"
                              onClick={() => setEditingPosId(null)}
                              className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition-colors"
                            >
                              Annuller
                            </button>
                            <button
                              type="button"
                              disabled={isSavingEdit}
                              onClick={() => handleSaveEdit(pos.id)}
                              className="px-3.5 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-slate-950 font-bold text-xs transition-colors flex items-center gap-1.5"
                            >
                              <RefreshCw className={`w-3 h-3 ${isSavingEdit ? 'animate-spin' : ''}`} />
                              <span>{isSavingEdit ? 'Gemmer...' : 'Gem Ændringer'}</span>
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Visual Stop-Loss <-> Entry <-> Target Progress Bar */}
                      <div className="space-y-1.5 pt-1">
                        <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
                          <span className="text-rose-400 font-semibold">
                            🛑 Stop-Loss: {currSym}{pos.stopLossPrice}
                          </span>
                          <span className="text-slate-400">
                            📍 Din Entry: {currSym}{pos.entryPrice}
                          </span>
                          <span className="text-emerald-400 font-semibold">
                            🎯 Mål: {currSym}{pos.targetPrice}
                          </span>
                        </div>

                        <div className="relative h-2.5 bg-slate-950 rounded-full border border-slate-800 overflow-hidden">
                          {/* Progress fill up to current price */}
                          <div
                            className={`h-full transition-all duration-500 ${
                              isProfit ? 'bg-gradient-to-r from-teal-500 to-emerald-400' : 'bg-gradient-to-r from-rose-600 to-rose-400'
                            }`}
                            style={{ width: `${currPct}%` }}
                          />

                          {/* Marker for Entry Price */}
                          <div
                            className="absolute top-0 bottom-0 w-0.5 bg-cyan-400 z-10"
                            style={{ left: `${entryPct}%` }}
                            title={`Entry Kurs: ${currSym}${pos.entryPrice}`}
                          />
                        </div>
                      </div>

                      {/* Verifikations-linje i bunden af kortet med live kurs, tidsstempel, kilde, FX & eksterne links */}
                      <div className="pt-2.5 border-t border-slate-800/80 flex flex-col md:flex-row md:items-center justify-between gap-2.5 text-[11px] font-mono">
                        <div className="flex items-center gap-2 text-slate-300 flex-wrap">
                          {/* Ingen "verificeret": en fejlet opdatering beholder den gamle kurs – tidspunktet står ved siden af. */}
                          <span className="flex items-center gap-1.5 text-slate-100 font-bold">
                            Seneste kurs: {currSym}{pos.currentPrice}
                          </span>
                          <span className="text-slate-600">•</span>
                          <span className="text-slate-400">
                            Seneste børs-tick: <span className="text-slate-200">{formatQuoteTime(pos.lastQuoteTime)}</span>
                          </span>
                          <span className="text-slate-600">•</span>
                          <span className="text-slate-400">
                            Kilde: <span className="text-cyan-300 font-semibold">{pos.quoteSource || 'ukendt'}</span>
                          </span>
                          <span className="text-slate-600">•</span>
                          <span className="text-slate-400">
                            Valuta: <span className="text-amber-300">{pos.currentFxRateDkk > 0 ? `1 ${currencyCode} = ${Number(pos.currentFxRateDkk).toFixed(4)} DKK` : 'mangler live valutakurs'}</span>
                          </span>
                        </div>

                        <div className="flex items-center gap-2 self-end md:self-auto shrink-0">
                          <a
                            href={nordnetUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition-colors text-[10px]"
                            title="Tjek kursen live hos Nordnet"
                          >
                            <span>Nordnet</span>
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                          <a
                            href={yahooUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition-colors text-[10px]"
                            title="Tjek kursen live hos Yahoo Finance"
                          >
                            <span>Yahoo Finance</span>
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
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
                  Claude Haiku Gatekeeper • Sonnet Specialister • Opus / Sonnet CIO
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
                  title="Dommer: Claude Opus (CLAUDE_JUDGE_MODEL) med adaptive thinking"
                >
                  <Brain className="w-3.5 h-3.5 text-purple-400" />
                  <span>🧠 OPUS CIO</span>
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
                  title="Dommer: specialistmodellen (Sonnet) – hurtigere og billigere"
                >
                  <Zap className="w-3.5 h-3.5 text-cyan-400" />
                  <span>⚡ SONNET CIO</span>
                </button>
              </div>

              {/* Gen-evaluér med nyeste kurs & data knap */}
              {selectedTx && (
                <button
                  type="button"
                  onClick={() => handleConveneCouncil(selectedTx, true)}
                  disabled={councilLoading}
                  className="px-3.5 py-1.5 rounded bg-gradient-to-r from-purple-900 to-indigo-900 hover:from-purple-800 hover:to-indigo-800 border border-purple-500/80 text-purple-200 hover:text-white font-mono text-xs font-bold transition-all flex items-center gap-1.5 shadow-md shadow-purple-950 disabled:opacity-50"
                  title="Hent spritnye live markedskurser og 14d ATR og kør en frisk rådsdom med det samme"
                >
                  <RefreshCw className={`w-3.5 h-3.5 text-cyan-300 ${councilLoading ? 'animate-spin' : ''}`} />
                  <span>🔄 Gen-evaluér med nyeste kurs & data</span>
                </button>
              )}

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

          {/* Rådsfejl i kammeret */}
          {councilError && (
            <div role="alert" className="p-3 rounded bg-rose-950/40 border border-rose-800 text-rose-300 text-xs font-mono flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
              <span className="flex-1">{councilError}</span>
              <button onClick={() => setCouncilError(null)} className="text-rose-400 hover:text-rose-200" aria-label="Luk fejlbesked">
                ✕
              </button>
            </div>
          )}

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
                    <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-slate-400">
                      <span>CHIEF INVESTMENT OFFICER (THE JUDGE)</span>
                      <span>•</span>
                      <span className="text-cyan-400 font-bold">
                        {selectedTx.ticker} ({selectedTx.insiderName}, {selectedTx.insiderTitle})
                      </span>
                      {(activeVerdict.evaluatedAt || activeVerdict.timestamp) && (
                        <>
                          <span>•</span>
                          <span className="text-slate-300">
                            Vurderet: {formatDateTimeDk(activeVerdict.evaluatedAt || activeVerdict.timestamp)}
                            {activeVerdict.priceAtEvaluation ? ` @ $${activeVerdict.priceAtEvaluation}` : ''}
                          </span>
                        </>
                      )}
                    </div>
                    <h3 className="text-lg font-bold text-slate-100 mt-1 font-sans">
                      {activeVerdict.headline}
                    </h3>
                    {selectedTx.exchange && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[11px]">
                        <span
                          className={`px-2 py-0.5 rounded border text-[10px] font-semibold flex items-center gap-1 ${
                            selectedTx.isTradableInDK === true
                              ? 'bg-emerald-950/70 border-emerald-700 text-emerald-300'
                              : selectedTx.isTradableInDK === false
                              ? 'bg-rose-950/70 border-rose-700 text-rose-300'
                              : 'bg-slate-800/60 border-slate-600 text-slate-400'
                          }`}
                          title={selectedTx.tradabilityReason}
                        >
                          {selectedTx.isTradableInDK === true
                            ? '✅ Handelbar i DK'
                            : selectedTx.isTradableInDK === false
                            ? '🚫 Ikke godkendt i DK'
                            : '❔ Handelbarhed: mangler data'}
                          : {selectedTx.exchange}
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

                    {selectedTx.is10b51Plan && (
                      <div className="mt-1.5 flex items-center gap-2 font-mono text-[11px]">
                        <span className="px-2 py-0.5 rounded border text-[10px] font-semibold bg-red-950/80 border-red-700 text-red-300 flex items-center gap-1">
                          🤖 10b5-1 AUTO-PLAN: Form 4 indberetter handlen som forudbestemt automatisk program (0% aktuel asymmetri)
                        </span>
                      </div>
                    )}

                    {/* Direct Broker & Chart Quick Links */}
                    <div className="mt-2.5 flex flex-wrap items-center gap-2 font-mono text-xs">
                      <a
                        href={`https://finance.yahoo.com/quote/${encodeURIComponent(selectedTx.ticker)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 transition-colors flex items-center gap-1.5"
                      >
                        <span>📈 Yahoo Finance Chart</span>
                        <ExternalLink className="w-3 h-3 text-cyan-400" />
                      </a>
                      <a
                        href={`https://www.nordnet.dk/markedet/aktiekurser?query=${encodeURIComponent(
                          selectedTx.ticker.replace(/\.(CO|ST)$/i, '')
                        )}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-2.5 py-1 rounded bg-emerald-950/60 hover:bg-emerald-900/60 border border-emerald-700 text-emerald-300 transition-colors flex items-center gap-1.5"
                      >
                        <span>🔎 Søg på Nordnet</span>
                        <ExternalLink className="w-3 h-3 text-emerald-400" />
                      </a>
                      {selectedTx.secFilingUrl && (
                        <a
                          href={selectedTx.secFilingUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-2.5 py-1 rounded bg-purple-950/60 hover:bg-purple-900/60 border border-purple-700 text-purple-300 transition-colors flex items-center gap-1.5"
                        >
                          <span>📄 Officiel Filing</span>
                          <ExternalLink className="w-3 h-3 text-purple-400" />
                        </a>
                      )}
                    </div>
                  </div>

                  {/* Verdict Badge & Score */}
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="text-[10px] font-mono text-slate-400">ASYMMETRY SCORE</div>
                      <div className="text-3xl font-mono font-bold text-slate-100 flex items-baseline justify-end gap-1">
                        {activeVerdict.previousScore !== undefined &&
                          activeVerdict.previousScore !== activeVerdict.asymmetryScore && (
                            <span className="text-sm font-normal text-slate-400">
                              {activeVerdict.previousScore} →
                            </span>
                          )}
                        <span>{activeVerdict.asymmetryScore}</span>
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
                    Gatekeeper: {activeVerdict.modelsUsed?.gatekeeper || 'ukendt'}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-cyan-950/60 border border-cyan-800 text-cyan-300">
                    Specialister: {activeVerdict.modelsUsed?.specialists || 'ukendt'} (x3)
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded border ${
                      activeVerdict.modelsUsed?.judgeTier === 'opus'
                        ? 'bg-purple-950/80 border-purple-700 text-purple-200 font-semibold'
                        : 'bg-cyan-950/80 border-cyan-700 text-cyan-200'
                    }`}
                  >
                    CIO Dommer: {activeVerdict.modelsUsed?.judge || 'ukendt'}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded border ${
                      activeVerdict.validated
                        ? 'bg-emerald-950/60 border-emerald-800 text-emerald-300'
                        : 'bg-slate-800/60 border-slate-600 text-slate-400'
                    }`}
                    title={activeVerdict.validated ? 'Dommerens output bestod skema-validering' : 'Ældre dom fra før fase 1 – ikke skema-valideret. Vurdér igen.'}
                  >
                    {activeVerdict.validated ? `✓ Valideret · ${activeVerdict.promptVersion}` : '❔ Ikke valideret (ældre dom)'}
                  </span>
                </div>
              </div>

              {/* Dedicated Fundamental Balance Sheet, Cash Runway & Short Guard Card */}
              {(() => {
                const fundamentals =
                  selectedTx.fundamentals ||
                  verdictHistory[selectedTx.id]?.transaction.fundamentals;
                if (!fundamentals) return null;

                return (
                  <div className="p-4 rounded bg-slate-900/90 border border-slate-800 shadow-xl space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-2.5">
                      <div className="flex items-center gap-2">
                        <Landmark className="w-4 h-4 text-cyan-400" />
                        <span className="font-mono text-xs font-bold text-slate-200 uppercase tracking-wider">
                          FUNDAMENTAL BALANCE, CASH RUNWAY & SHORT-SQUEEZE GUARD
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <span
                          className={`px-2.5 py-1 rounded text-xs font-mono font-bold border ${
                            fundamentals.fundamentalHealthBadge === 'FORTRESS_BALANCE'
                              ? 'bg-emerald-950/90 border-emerald-500 text-emerald-300 shadow-md shadow-emerald-950'
                              : fundamentals.fundamentalHealthBadge === 'SHORT_SQUEEZE_SETUP'
                              ? 'bg-amber-950/90 border-amber-500 text-amber-300 shadow-md shadow-amber-950'
                              : fundamentals.fundamentalHealthBadge === 'DILUTION_RISK'
                              ? 'bg-rose-950/90 border-rose-500 text-rose-300 shadow-md shadow-rose-950'
                              : fundamentals.fundamentalHealthBadge === 'SOLID_RUNWAY'
                              ? 'bg-cyan-950/80 border-cyan-600 text-cyan-300'
                              : fundamentals.fundamentalHealthBadge === 'UNKNOWN'
                              ? 'bg-slate-800/60 border-slate-600 text-slate-400'
                              : 'bg-slate-800/80 border-slate-700 text-slate-300'
                          }`}
                        >
                          {fundamentals.fundamentalHealthBadge === 'FORTRESS_BALANCE' && '🏰 Fortress Cash'}
                          {fundamentals.fundamentalHealthBadge === 'SHORT_SQUEEZE_SETUP' && '🔥 Short Squeeze Setup'}
                          {fundamentals.fundamentalHealthBadge === 'DILUTION_RISK' && '⚠️ Dilution Risk (<9m)'}
                          {fundamentals.fundamentalHealthBadge === 'SOLID_RUNWAY' && '📈 Solid Runway'}
                          {fundamentals.fundamentalHealthBadge === 'NEUTRAL' && '⚖️ Neutral Balance'}
                          {fundamentals.fundamentalHealthBadge === 'UNKNOWN' && '❔ Mangler data'}
                        </span>
                      </div>
                    </div>

                    {/* Summary row */}
                    <div className="text-xs font-mono text-slate-300 bg-slate-950/70 p-2.5 rounded border border-slate-800/70">
                      {fundamentals.fundamentalSummary}
                    </div>

                    {/* 4 Key Pillars Grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 font-mono">
                      {/* 1. Kontanter vs Gæld */}
                      <div className="p-2.5 rounded bg-slate-950/60 border border-slate-800/80">
                        <div className="text-[10px] text-slate-400 uppercase flex items-center justify-between">
                          <span>Kontanter vs. Gæld</span>
                          <span className="text-[9px] text-cyan-400 font-bold">SEC XBRL</span>
                        </div>
                        <div className="mt-1 space-y-0.5 text-xs">
                          <div className="flex justify-between">
                            <span className="text-slate-400">Cash:</span>
                            <span className="text-emerald-400 font-bold">
                              {formatCompactUsd(fundamentals.cashAndEquivalentsUsd)}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-400">Gæld:</span>
                            <span className="text-rose-400 font-bold">
                              {formatCompactUsd(fundamentals.totalDebtUsd)}
                            </span>
                          </div>
                          <div className="flex justify-between border-t border-slate-800/60 pt-0.5 font-bold">
                            <span className="text-slate-400">Net Cash:</span>
                            <span
                              className={
                                fundamentals.netCashUsd === undefined
                                  ? TONE_CLASS.unknown
                                  : fundamentals.netCashUsd >= 0
                                  ? 'text-emerald-300'
                                  : 'text-rose-300'
                              }
                            >
                              {fundamentals.netCashUsd !== undefined && fundamentals.netCashUsd >= 0 ? '+' : ''}
                              {formatCompactUsd(fundamentals.netCashUsd)}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* 2. Cash Flow & Runway */}
                      <div className="p-2.5 rounded bg-slate-950/60 border border-slate-800/80">
                        <div className="text-[10px] text-slate-400 uppercase">Cash Flow & Runway</div>
                        <div className="mt-1 space-y-0.5 text-xs">
                          <div className="flex justify-between">
                            <span className="text-slate-400">Drift:</span>
                            <span className={fundamentals.isCashFlowPositive ? 'text-emerald-400 font-bold' : 'text-amber-400 font-bold'}>
                              {fundamentals.isCashFlowPositive
                                ? 'Cash-Flow Positiv'
                                : fundamentals.quarterlyCashBurnUsd
                                ? `-${formatCompactUsd(fundamentals.quarterlyCashBurnUsd)}/kvt`
                                : 'Ukendt'}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-400">Runway:</span>
                            {(() => {
                              const rl = runwayLabel(fundamentals);
                              return (
                                <span className={`font-bold ${rl.tone === 'bad' ? 'text-rose-400 animate-pulse' : rl.tone === 'good' && !fundamentals.isCashFlowPositive ? TONE_CLASS.neutral : TONE_CLASS[rl.tone]}`}>
                                  {fundamentals.isCashFlowPositive || fundamentals.estimatedRunwayMonths === null
                                    ? 'Uendelig (Overskud)'
                                    : rl.tone === 'unknown'
                                    ? 'ukendt'
                                    : `${fundamentals.estimatedRunwayMonths} mdr.`}
                                </span>
                              );
                            })()}
                          </div>
                          <div className={`text-[10px] pt-0.5 border-t border-slate-800/60 truncate ${runwayLabel(fundamentals).tone === 'unknown' ? TONE_CLASS.unknown : 'text-slate-400'}`}>
                            {runwayLabel(fundamentals).text}
                          </div>
                        </div>
                      </div>

                      {/* 3. Short Interest & Squeeze */}
                      <div className="p-2.5 rounded bg-slate-950/60 border border-slate-800/80">
                        <div className="text-[10px] text-slate-400 uppercase flex items-center justify-between">
                          <span>Short Interest</span>
                          {(fundamentals.shortPercentOfFloat ?? 0) >= 10 && (
                            <span className="text-[9px] text-amber-400 font-bold flex items-center gap-0.5">
                              <Flame className="w-2.5 h-2.5" /> High Short
                            </span>
                          )}
                        </div>
                        <div className="mt-1 space-y-0.5 text-xs">
                          <div className="flex justify-between">
                            <span className="text-slate-400">Short Float:</span>
                            <span
                              className={`font-bold ${
                                (fundamentals.shortPercentOfFloat ?? 0) >= 10 ? 'text-amber-400' : 'text-slate-200'
                              }`}
                            >
                              {fundamentals.shortPercentOfFloat !== undefined
                                ? `${fundamentals.shortPercentOfFloat.toFixed(1)}%`
                                : 'N/A'}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-400">Days to Cover:</span>
                            <span className="text-slate-200 font-bold">
                              {fundamentals.daysToCover !== undefined ? `${fundamentals.daysToCover}d` : 'N/A'}
                            </span>
                          </div>
                          <div className="text-[10px] text-slate-500 pt-0.5 border-t border-slate-800/60 truncate">
                            {fundamentals.shortPercentOfFloat === undefined
                              ? 'Short-andel ukendt'
                              : fundamentals.shortPercentOfFloat >= 12
                              ? '🔥 Short Squeeze kandidat'
                              : 'Normal short-andel'}
                          </div>
                        </div>
                      </div>

                      {/* 4. Regnskab & Multipler */}
                      <div className="p-2.5 rounded bg-slate-950/60 border border-slate-800/80">
                        <div className="text-[10px] text-slate-400 uppercase">Regnskab & Multipler</div>
                        <div className="mt-1 space-y-0.5 text-xs">
                          <div className="flex justify-between">
                            <span className="text-slate-400">Earnings:</span>
                            <span className="text-slate-200 font-bold">
                              {fundamentals.nextEarningsDate
                                ? `${fundamentals.nextEarningsDate.substring(5)}${fundamentals.daysUntilEarnings !== undefined ? ` (+${fundamentals.daysUntilEarnings}d)` : ''}${fundamentals.nextEarningsDateEstimated ? ' est.' : ''}`
                                : 'mangler data'}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-400">P/E:</span>
                            <span className="text-slate-200 font-bold">
                              {fundamentals.peRatio === undefined
                                ? 'mangler data'
                                : fundamentals.peRatio === null
                                ? 'Negativ'
                                : fundamentals.peRatio.toFixed(1)}
                            </span>
                          </div>
                          <div className="flex justify-between border-t border-slate-800/60 pt-0.5">
                            <span className="text-slate-400">P/B:</span>
                            <span className="text-slate-200 font-bold">
                              {fundamentals.priceToBook !== null && fundamentals.priceToBook !== undefined
                                ? fundamentals.priceToBook.toFixed(2)
                                : 'N/A'}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              <ClusterBuyers tx={selectedTx} />

              {/* Dedicated Insider Track Record & Sniper Engine Card */}
              {selectedTx.trackRecord && (
                <div className="p-4 rounded bg-slate-900/90 border border-slate-800 shadow-xl space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-2.5">
                    <div className="flex items-center gap-2">
                      <Target className="w-4 h-4 text-emerald-400" />
                      <span className="font-mono text-xs font-bold text-slate-200 uppercase tracking-wider">
                        INSIDER TRACK RECORD & HISTORISK TRÆFSIKKERHED
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2.5 py-1 rounded text-xs font-mono font-bold border ${
                          selectedTx.trackRecord.reputation === 'SMART_MONEY_SNIPER'
                            ? 'bg-emerald-950/90 border-emerald-500 text-emerald-300 shadow-md shadow-emerald-950'
                            : selectedTx.trackRecord.reputation === 'EARLY_OR_BAGHOLDER'
                            ? 'bg-rose-950/90 border-rose-500 text-rose-300 shadow-md shadow-rose-950'
                            : selectedTx.trackRecord.reputation === 'FIRST_TIME_OR_RARE'
                            ? 'bg-cyan-950/80 border-cyan-600 text-cyan-300'
                            : selectedTx.trackRecord.reputation === 'UNKNOWN'
                            ? 'bg-slate-800/60 border-slate-600 text-slate-400'
                            : 'bg-blue-950/80 border-blue-600 text-blue-300'
                        }`}
                      >
                        {selectedTx.trackRecord.reputationLabel}
                      </span>
                    </div>
                  </div>

                  {/* Key Stats Bar – skjules ved UNKNOWN, så 0-tal ikke ligner målte tal */}
                  {selectedTx.trackRecord.reputation !== 'UNKNOWN' && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 font-mono text-center">
                    <div className="p-2.5 rounded bg-slate-950/60 border border-slate-800/80">
                      <div className="text-[10px] text-slate-400 uppercase">Målte køb (afkast efter 6 mdr.)</div>
                      <div className="text-lg font-bold text-slate-100 mt-0.5">
                        {selectedTx.trackRecord.historicalBuysCount}
                        <span className="text-xs text-slate-500 font-normal ml-1">handler</span>
                      </div>
                    </div>

                    <div className="p-2.5 rounded bg-slate-950/60 border border-slate-800/80">
                      <div className="text-[10px] text-slate-400 uppercase">Historisk Win-Rate</div>
                      <div
                        className={`text-lg font-bold mt-0.5 ${
                          selectedTx.trackRecord.winRatePct >= 65
                            ? 'text-emerald-400'
                            : selectedTx.trackRecord.winRatePct <= 30
                            ? 'text-rose-400'
                            : 'text-slate-100'
                        }`}
                      >
                        {selectedTx.trackRecord.winRatePct}%
                      </div>
                    </div>

                    <div className="p-2.5 rounded bg-slate-950/60 border border-slate-800/80">
                      <div className="text-[10px] text-slate-400 uppercase">Gennemsnitligt Afkast</div>
                      <div
                        className={`text-lg font-bold mt-0.5 ${
                          selectedTx.trackRecord.avgReturnPct > 0
                            ? 'text-emerald-400'
                            : selectedTx.trackRecord.avgReturnPct < 0
                            ? 'text-rose-400'
                            : 'text-slate-100'
                        }`}
                      >
                        {selectedTx.trackRecord.avgReturnPct > 0 ? '+' : ''}
                        {selectedTx.trackRecord.avgReturnPct}%
                      </div>
                    </div>
                  </div>
                  )}

                  {/* Selskabets historik ovenfor; insiderens egen historik og ikke-målte køb her */}
                  {selectedTx.trackRecord.horizonTradingDays !== undefined && (
                    <div className="text-[11px] font-mono text-slate-300">
                      {selectedTx.insiderName} selv:{' '}
                      {selectedTx.trackRecord.insiderOnly && selectedTx.trackRecord.insiderOnly.historicalBuysCount > 0
                        ? `${selectedTx.trackRecord.insiderOnly.historicalBuysCount} målte køb, ${selectedTx.trackRecord.insiderOnly.winRatePct}% win rate, gns. ${selectedTx.trackRecord.insiderOnly.avgReturnPct > 0 ? '+' : ''}${selectedTx.trackRecord.insiderOnly.avgReturnPct}%`
                        : 'ingen målte køb'}
                      {' • '}Ikke målt (yngre end 6 mdr.): {selectedTx.trackRecord.unmeasuredBuysCount ?? 0}
                      {' • '}
                      {selectedTx.trackRecord.excludedOfferingBuys === undefined
                        ? <span className="text-slate-500">udbud/IPO ikke tjekket</span>
                        : `${selectedTx.trackRecord.excludedOfferingBuys} køb i udbud/IPO udeladt`}
                    </div>
                  )}

                  {/* Notable Past Trades List */}
                  {selectedTx.trackRecord.notablePastTrades.length > 0 ? (
                    <div className="mt-2 space-y-1.5">
                      <div className="text-[11px] font-mono text-slate-400 uppercase">
                        Udvalgte historiske køb i aktien:
                      </div>
                      <div className="divide-y divide-slate-800/60 rounded border border-slate-800/80 bg-slate-950/40 overflow-hidden text-xs font-mono">
                        {selectedTx.trackRecord.notablePastTrades.map((trade, idx) => (
                          <div
                            key={idx}
                            className="p-2 flex flex-wrap items-center justify-between gap-2 hover:bg-slate-900/50 transition-colors"
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-slate-400">{trade.date}</span>
                              <span className="text-slate-200 font-medium font-sans">
                                {trade.insiderName} {trade.insiderTitle ? `(${trade.insiderTitle})` : ''}
                              </span>
                            </div>

                            <div className="flex items-center gap-3">
                              <span className="text-slate-400">
                                Købt @ ${trade.price} ($
                                {trade.valueUsd >= 1000000
                                  ? `${(trade.valueUsd / 1000000).toFixed(1)}M`
                                  : `${Math.round(trade.valueUsd / 1000)}k`}
                                )
                              </span>
                              <span
                                className={`px-2 py-0.5 rounded font-bold ${
                                  trade.returnPct > 0
                                    ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-800'
                                    : 'bg-rose-950/80 text-rose-300 border border-rose-800'
                                }`}
                              >
                                {trade.returnPct > 0 ? '+' : ''}
                                {trade.returnPct}%
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="p-2.5 rounded bg-slate-950/40 border border-slate-800/60 text-xs text-slate-400 font-mono">
                      {selectedTx.trackRecord.reputation === 'UNKNOWN'
                        ? 'Track record ukendt – opslaget fejlede, eller tickeren er ikke amerikansk. Det er ikke et signal.'
                        : 'Ingen tidligere registrerede åbne markedskøb i selskabet de seneste 3-4 år. Dette indikerer et sjældent regimeskift eller ny overbevisning fra ledelsen.'}
                    </div>
                  )}
                </div>
              )}

              {/* Quantitative Trade Execution, ATR Volatility & Position Sizing Plan */}
              {(() => {
                const plan = generateTradeExecutionPlan(selectedTx, activeVerdict, maxCapitalDkk, fxRates);
                const isDkk = selectedTx.ticker.endsWith('.CO') || selectedTx.exchange?.includes('Copenhagen');
                const isSek = selectedTx.ticker.endsWith('.ST') || selectedTx.exchange?.includes('Stockholm');
                const currSym = isDkk ? 'DKK ' : isSek ? 'SEK ' : '$';

                return (
                  <div className="p-4 rounded-lg bg-slate-900/90 border border-slate-800 shadow-xl space-y-4">
                    {/* Header with Title, Volatility Tag & Capital Selector */}
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-slate-800">
                      <div className="flex items-center gap-2.5">
                        <div className="p-2 rounded bg-emerald-950/60 border border-emerald-700/50 text-emerald-400">
                          <Calculator className="w-4 h-4" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h4 className="text-xs font-mono font-bold tracking-wider text-slate-200">
                              📐 QUANTITATIVE EXECUTION & RISK PLAN (FRIE MIDLER)
                            </h4>
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold border ${
                                plan.status === 'DO_NOT_TRADE'
                                  ? 'bg-rose-950/60 border-rose-800/80 text-rose-300'
                                  : plan.volatilityTag.includes('Ekstrem')
                                  ? 'bg-amber-950/60 border-amber-700/80 text-amber-300'
                                  : 'bg-emerald-950/60 border-emerald-700/80 text-emerald-300'
                              }`}
                            >
                              {plan.volatilityTag}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-400 font-mono mt-0.5">
                            ATR-baseret stop-loss, positionsstørrelse & 2-tranche limit eksekvering
                          </p>
                        </div>
                      </div>

                      {/* Capital Frame Selector & Paper Trade Action */}
                      <div className="flex flex-wrap items-center gap-2 self-start md:self-auto">
                        <div className="flex items-center gap-1.5 bg-slate-950 p-1 rounded border border-slate-800">
                          <span className="text-[10px] font-mono text-slate-400 px-2 font-medium">Allokeringsramme:</span>
                          {[10000, 25000, 50000, 100000].map((amt) => {
                            const isSelected = maxCapitalDkk === amt;
                            return (
                              <button
                                key={amt}
                                onClick={() => handleSelectCapitalFrame(amt)}
                                className={`px-2 py-1 rounded text-[10px] font-mono font-bold transition-all ${
                                  isSelected
                                    ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/40'
                                    : 'bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                                }`}
                              >
                                {(amt / 1000).toFixed(0)}k kr.
                              </button>
                            );
                          })}
                        </div>

                        {plan.status === 'ACTIVE_PLAN' && (
                          paperPortfolio[selectedTx.id] ? (
                            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-950/80 border border-emerald-500/70 text-emerald-300 font-mono text-[11px] shadow-sm">
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                              <span className="font-bold">AKTIV I PAPER-PORTEFØLJE</span>
                              <span className="text-slate-500">•</span>
                              <span
                                className={
                                  paperPortfolio[selectedTx.id].pnlDkk >= 0
                                    ? 'text-emerald-400 font-bold'
                                    : 'text-rose-400 font-bold'
                                }
                              >
                                {paperPortfolio[selectedTx.id].pnlDkk >= 0 ? '+' : ''}
                                {paperPortfolio[selectedTx.id].pnlDkk.toLocaleString('da-DK')} DKK (
                                {paperPortfolio[selectedTx.id].pnlPct}%)
                              </span>
                            </div>
                          ) : (
                            <button
                              onClick={() => handleOpenPaperTrade(selectedTx, plan)}
                              disabled={portfolioLoading}
                              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-mono text-xs font-bold transition-all shadow-md shadow-emerald-950/40 hover:shadow-emerald-950/60 active:scale-95 disabled:opacity-50"
                            >
                              <Bookmark className="w-3.5 h-3.5" />
                              <span>📌 Åbn Paper-Trade ({plan.recommendedAllocationDkk.toLocaleString('da-DK')} kr.)</span>
                            </button>
                          )
                        )}
                      </div>
                    </div>

                    {plan.status === 'DO_NOT_TRADE' ? (
                      <div className="p-3.5 rounded bg-rose-950/30 border border-rose-900/60 text-rose-200 text-xs font-mono space-y-1">
                        <div className="flex items-center gap-2 font-bold text-rose-300">
                          <AlertTriangle className="w-4 h-4 text-rose-400" />
                          <span>KAPITALBESKYTTELSE AKTIV // INGEN ORDRE ANBEFALES</span>
                        </div>
                        <p className="text-slate-300 text-[11px] leading-relaxed">
                          {plan.reason}
                        </p>
                      </div>
                    ) : (
                      <>
                        {/* 4 Quantitative Metric Cards */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                          {/* Card 1: Allokering & Aktier */}
                          <div className="p-3 rounded bg-slate-950/70 border border-slate-800 space-y-1">
                            <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                              <span>Position & Aktier</span>
                              <Zap className="w-3.5 h-3.5 text-emerald-400" />
                            </div>
                            <div className="text-base font-bold font-mono text-emerald-400">
                              {plan.recommendedAllocationDkk.toLocaleString('da-DK')} DKK
                            </div>
                            <div className="text-[11px] font-mono text-slate-300">
                              {plan.totalShares} aktier {!isDkk && `($${plan.recommendedAllocationUsd.toLocaleString('en-US')})`}
                            </div>
                            <div className="text-[10px] font-mono text-slate-400 pt-1 border-t border-slate-800/60">
                              T1: {plan.tranche1.shares} stk. | T2: {plan.tranche2.shares} stk.
                            </div>
                          </div>

                          {/* Card 2: Entry Zone */}
                          <div className="p-3 rounded bg-slate-950/70 border border-slate-800 space-y-1">
                            <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                              <span>Entry Zone</span>
                              <Target className="w-3.5 h-3.5 text-cyan-400" />
                            </div>
                            <div className="text-base font-bold font-mono text-cyan-300">
                              {currSym}{plan.entryZoneMin} - {currSym}{plan.entryZoneMax}
                            </div>
                            <div className="text-[11px] font-mono text-slate-300">
                              Insider køb: {currSym}{selectedTx.pricePerShare || '-'}
                            </div>
                            <div className="text-[10px] font-mono text-cyan-400/90 truncate pt-1 border-t border-slate-800/60" title={plan.entryZoneLabel}>
                              {plan.entryZoneLabel}
                            </div>
                          </div>

                          {/* Card 3: ATR Volatilitet Stop-Loss */}
                          <div className="p-3 rounded bg-slate-950/70 border border-slate-800 space-y-1">
                            <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                              <span>ATR Stop-Loss (Hard)</span>
                              <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
                            </div>
                            <div className="text-base font-bold font-mono text-rose-400">
                              {currSym}{plan.stopLossPrice}
                            </div>
                            <div className="text-[11px] font-mono text-rose-300">
                              {plan.stopLossRiskPct}% risiko fra aktuel
                            </div>
                            <div className="text-[10px] font-mono text-slate-400 pt-1 border-t border-slate-800/60">
                              Maks tab: -{plan.maxLossDkk.toLocaleString('da-DK')} DKK
                            </div>
                          </div>

                          {/* Card 4: Kursmål & Risk/Reward */}
                          <div className="p-3 rounded bg-slate-950/70 border border-slate-800 space-y-1">
                            <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                              <span>Kursmål (90d Modstand)</span>
                              <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
                            </div>
                            <div className="text-base font-bold font-mono text-emerald-300">
                              {currSym}{plan.targetPrice1} (+{plan.targetReturnPct1}%)
                            </div>
                            <div className="text-[11px] font-mono text-amber-300 font-semibold">
                              Risk / Reward: 1 : {plan.riskRewardRatio}
                            </div>
                            <div className="text-[10px] font-mono text-slate-400 pt-1 border-t border-slate-800/60">
                              14d ATR: {currSym}{selectedTx.atr14d || '-'} ({selectedTx.dailyVolatilityPct || '-'}%/dag)
                            </div>
                          </div>
                        </div>

                        {/* Tranche Eksekverings-Instruktioner */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                          <div className="p-3 rounded bg-emerald-950/20 border border-emerald-900/50 space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="text-[11px] font-mono font-bold text-emerald-400 flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                                TRANCHE 1: 60% EKSEKVERING
                              </span>
                              <span className="text-[11px] font-mono font-bold text-emerald-300">
                                {plan.tranche1.allocationDkk.toLocaleString('da-DK')} DKK
                              </span>
                            </div>
                            <p className="text-xs font-mono text-slate-200 font-medium">
                              {plan.tranche1.shares} aktier @ {currSym}{plan.tranche1.price} (Markedsåbning / Limit)
                            </p>
                            <p className="text-[10px] font-mono text-slate-400 leading-relaxed">
                              Lægges straks for at sikre indgangskurs tæt på insiderens køb og undgå at misse et ryk opad.
                            </p>
                          </div>

                          <div className="p-3 rounded bg-cyan-950/20 border border-cyan-900/50 space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="text-[11px] font-mono font-bold text-cyan-400 flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-cyan-400"></span>
                                TRANCHE 2: 40% PULLBACK LIMIT
                              </span>
                              <span className="text-[11px] font-mono font-bold text-cyan-300">
                                {plan.tranche2.allocationDkk.toLocaleString('da-DK')} DKK
                              </span>
                            </div>
                            <p className="text-xs font-mono text-slate-200 font-medium">
                              {plan.tranche2.shares} aktier @ {currSym}{plan.tranche2.price} (Støtte / Pullback)
                            </p>
                            <p className="text-[10px] font-mono text-slate-400 leading-relaxed">
                              Lægges som stående limit-ordre i bunden af ordrebogen for at gribe eventuelle intradag-dips.
                            </p>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}

              {/* Dommerens thinking-resumé – kun det, API'et faktisk returnerede */}
              {activeVerdict.judgeThinking && (
                <div className="rounded bg-slate-950 border border-purple-900/60 overflow-hidden shadow-lg shadow-purple-950/20">
                  <button
                    onClick={() => setShowThinking(!showThinking)}
                    className="w-full px-4 py-2.5 bg-gradient-to-r from-purple-950/60 via-slate-900 to-slate-900 hover:from-purple-950/80 transition-colors flex items-center justify-between text-left font-mono text-xs border-b border-purple-900/40"
                  >
                    <div className="flex items-center gap-2 text-purple-300 font-bold tracking-wide">
                      <Brain className="w-4 h-4 text-purple-400" />
                      <span>🧠 DOMMERENS RÆSONNEMENT (RESUMÉ FRA API)</span>
                    </div>
                    <div className="flex items-center gap-2 text-purple-300/80 text-[11px]">
                      <span className="px-1.5 py-0.5 rounded bg-purple-900/50 border border-purple-700/60 text-purple-200">
                        {activeVerdict.modelsUsed?.judge || 'ukendt model'}
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
