export type TransactionCode = 'P' | 'S' | 'A' | 'M' | 'F' | 'G' | 'D';

export interface InsiderTransaction {
  id: string;
  filingDate: string;
  ticker: string;
  companyName: string;
  insiderName: string;
  insiderTitle: string; // f.eks. "CFO", "CEO", "General Counsel", "Director", "10% Owner"
  transactionCode: TransactionCode;
  shares: number;
  pricePerShare: number;
  totalValueUsd: number;
  sharesOwnedFollowing: number;
  holdingsIncreasePct: number; // beregnet % stigning i insiderens samlede beholdning
  isClusterBuy: boolean; // om flere insidere har købt inden for 10 dage
  clusterCount?: number;
  recentPriceChange30dPct?: number; // kursændring seneste 30 dage op til købet
  secFilingUrl: string;
  contextNotes?: string;
  currentMarketPrice?: number; // aktuel markedspris fra Yahoo Finance
  returnSinceBuyPct?: number; // % ændring fra insiderens købspris til aktuel markedspris
  isTradingBelowInsiderPrice?: boolean; // true hvis aktuel kurs < insiderens købspris (kode P)
  ownershipNature?: 'D' | 'I'; // 'D' = Direct (personlige aktier), 'I' = Indirect (fond/LLC/trust)
  isExecutiveOfficer?: boolean; // true hvis CEO/CFO/COO/Pres/VP/GC/Chief/Counsel
  clusterPeers?: string[]; // Med-købere i samme selskab inden for samme tidsvindue
  exchange?: string; // f.eks. 'NASDAQ', 'NYSE', 'CPH (Nasdaq Copenhagen)', 'OTC'
  isTradableInDK?: boolean; // Om aktien er verificeret købbar på standard danske mæglerplatforme (Nordnet/Saxo)
  tradabilityReason?: string; // Begrundelse for handelbarhed eller afvisningsårsag
  avgDailyDollarVolume?: number; // Gennemsnitlig daglig handelsvolumen i USD
  marketCapUsd?: number;
  is10b51Plan?: boolean; // True hvis handlen er udført under en forudbestemt Rule 10b5-1 automatisk handelsplan
  footnotesSummary?: string; // Ekstraherede fodnoter fra indberetningen
  trackRecord?: InsiderTrackRecord; // Historisk træfsikkerhed og win-rate for insideren/ledelsen
  atr14d?: number; // 14-dages Average True Range i aktiens valuta
  dailyVolatilityPct?: number; // (atr14d / currentMarketPrice) * 100 - normal daglig udsving i %
  supportLow30d?: number; // Laveste lukkekurs de seneste 30 dage
  resistanceHigh90d?: number; // Højeste kurs de seneste 90 dage
  fundamentals?: CompanyFundamentals; // Fundamental balance sheet, cash runway, short interest & earnings data
}

export type FundamentalHealthBadge =
  | 'FORTRESS_BALANCE'
  | 'SOLID_RUNWAY'
  | 'SHORT_SQUEEZE_SETUP'
  | 'DILUTION_RISK'
  | 'NEUTRAL';

export interface CompanyFundamentals {
  cashAndEquivalentsUsd?: number; // Kontanter + kortfristede værdipapirer i USD
  totalDebtUsd?: number; // Samlet kort- og langfristet gæld i USD
  netCashUsd?: number; // cashAndEquivalentsUsd - totalDebtUsd
  quarterlyCashBurnUsd?: number; // Kvartalsvist drifttab / negativt Operating Cash Flow i USD, hvis selskabet brænder penge
  estimatedRunwayMonths?: number | null; // Beregnet Cash Runway i måneder hvis cash burn > 0, ellers null hvis selskabet er cash-flow positivt!
  isCashFlowPositive?: boolean;
  shortPercentOfFloat?: number; // Procent af free float der er shortet, f.eks. 14.5
  daysToCover?: number; // Short ratio / dage til at dække shorts
  nextEarningsDate?: string; // ISO dato for næste kvartalsregnskab
  daysUntilEarnings?: number; // Antal dage til/fra regnskab
  peRatio?: number | null;
  priceToBook?: number | null;
  fundamentalHealthBadge: FundamentalHealthBadge;
  fundamentalSummary: string; // Kort, præcis 1-linjes dansk opsummering
}

export interface TradeTranche {
  shares: number;
  price: number;
  allocationDkk: number;
  allocationUsd: number;
  description: string;
}

export interface TradeExecutionPlan {
  status: 'ACTIVE_PLAN' | 'DO_NOT_TRADE';
  reason?: string;
  recommendedAllocationDkk: number;
  recommendedAllocationUsd: number;
  totalShares: number;
  entryZoneMin: number;
  entryZoneMax: number;
  entryZoneLabel: string;
  stopLossPrice: number;
  stopLossRiskPct: number;
  maxLossDkk: number;
  targetPrice1: number;
  targetReturnPct1: number;
  riskRewardRatio: number;
  tranche1: TradeTranche;
  tranche2: TradeTranche;
  volatilityTag: string;
}

export type PaperTradeStatus = 'OPEN' | 'STOPPED_OUT' | 'TARGET_HIT' | 'CLOSED_MANUAL';

export type TradeType = 'PAPER' | 'REAL_NORDNET';

export interface InsiderExitWarning {
  hasExit: boolean;
  sellerName?: string;
  sellerTitle?: string;
  saleDate?: string;
  saleValueUsd?: number;
  message?: string;
}

export interface PaperTradePosition {
  id: string;
  ticker: string;
  companyName: string;
  exchange: string;
  insiderName: string;
  insiderTitle: string;
  asymmetryScore: number;
  openedAt: string;
  insiderBuyPrice: number;
  entryPrice: number;
  currentPrice: number;
  entryFxRateDkk: number;
  currentFxRateDkk: number;
  lastQuoteTime: string;
  quoteSource: string;
  insiderPnlPct: number;
  shares: number;
  investedDkk: number;
  stopLossPrice: number;
  targetPrice: number;
  pnlPct: number;
  pnlDkk: number;
  status: PaperTradeStatus;
  tradeType?: TradeType; // 'PAPER' | 'REAL_NORDNET'
  benchmarkTicker?: string; // default 'SPY'
  benchmarkEntryPrice?: number; // S&P 500 SPY kurs da positionen blev åbnet
  benchmarkCurrentPrice?: number; // aktuel SPY live kurs
  benchmarkReturnPct?: number; // ((benchmarkCurrentPrice - benchmarkEntryPrice) / benchmarkEntryPrice) * 100
  alphaPct?: number; // pnlPct - benchmarkReturnPct
  insiderExitWarning?: InsiderExitWarning;
}

export interface PortfolioSummary {
  totalInvestedDkk: number;
  totalCurrentValueDkk: number;
  totalPnlDkk: number;
  totalPnlPct: number;
  winRatePct: number;
  openCount: number;
  closedCount: number;
  avgAlphaPct?: number; // porteføljens vægtede Alpha mod S&P 500
  benchmarkReturnPct?: number; // S&P 500 afkast i samme periode
}

export type TrackRecordReputation =
  | 'SMART_MONEY_SNIPER'
  | 'CREDIBLE_BUYER'
  | 'FIRST_TIME_OR_RARE'
  | 'EARLY_OR_BAGHOLDER';

export interface NotablePastTrade {
  date: string;
  insiderName: string;
  insiderTitle?: string;
  price: number;
  valueUsd: number;
  returnPct: number;
}

export interface InsiderTrackRecord {
  historicalBuysCount: number;
  winRatePct: number;
  avgReturnPct: number;
  reputation: TrackRecordReputation;
  reputationLabel: string;
  notablePastTrades: NotablePastTrade[];
}

export type AsymmetrySignal = 'HIGH' | 'MEDIUM' | 'LOW' | 'NOISE';

export interface GatekeeperResult {
  passedHardFilter: boolean;
  hardFilterReason?: string;
  geminiPreScore: number; // 0-100
  asymmetrySignal: AsymmetrySignal;
  quickReasoning: string;
}

export interface CouncilReports {
  profiler: string;
  catalyst: string;
  skeptic: string;
}

export type CouncilVerdictType =
  | 'STRONG ASYMMETRY (KØB)'
  | 'MODERATE SIGNAL (OVERVÅG)'
  | 'PR STUNT / STØJ (IGNORER)';

export interface CouncilModelsUsed {
  gatekeeper: string;
  specialists: string;
  judge: string;
  judgeTier?: 'opus' | 'sonnet';
}

export interface CouncilVerdict {
  asymmetryScore: number; // 1-100
  verdict: CouncilVerdictType;
  headline: string;
  synthesis: string;
  reports: CouncilReports;
  timestamp: string;
  judgeThinking?: string;
  modelsUsed?: CouncilModelsUsed;
}
