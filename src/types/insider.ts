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
