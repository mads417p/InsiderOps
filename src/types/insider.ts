export type TransactionCode = 'P' | 'S' | 'A' | 'M' | 'F' | 'G' | 'D';

export interface InsiderTransaction {
  id: string;
  tradeDate?: string; // handelsdato (YYYY-MM-DD). undefined = ukendt (ældre poster fra før fase 2)
  filedAt?: string; // SEC-accept-tidspunkt eller meddelelsens offentliggørelse (ISO / "YYYY-MM-DDTHH:MM:SS" ET for OpenInsider)
  accessionNo?: string; // SEC accession-nummer (18 cifre) – dedup-nøgle sammen med ownerCik
  ownerCik?: string; // reporting owner CIK (uden foranstillede nuller)
  ticker: string;
  isin?: string; // nordiske meddelelser (MAR art. 19); SEC-rækker har intet ISIN
  companyName: string;
  insiderName: string;
  insiderTitle: string; // f.eks. "CFO", "CEO", "General Counsel", "Director", "10% Owner"
  transactionCode: TransactionCode;
  shares: number;
  pricePerShare: number; // insiderens kurs i `currency` (USD, hvis currency mangler)
  currency?: string; // valuta for pricePerShare og totalValueLocal (USD, DKK, SEK, EUR, NOK)
  totalValueLocal?: number; // handelsbeløb i lokal valuta (nordiske meddelelser)
  totalValueUsd: number; // USD-ækvivalent – kun til $50k-grænsen og rangering
  sharesOwnedFollowing?: number; // undefined = ikke oplyst
  holdingsIncreasePct?: number; // % stigning i insiderens beholdning. undefined = beholdning ukendt eller ny
  isClusterBuy: boolean; // om flere distinkte købere har købt inden for ±10 dage af lead-handlen
  clusterCount?: number;
  recentPriceChange30dPct?: number; // kursændring seneste 30 dage op til købet
  secFilingUrl: string;
  contextNotes?: string;
  currentMarketPrice?: number; // aktuel markedspris fra Yahoo Finance
  currentMarketPriceTime?: string; // Yahoo meta.regularMarketTime (UTC ISO) for currentMarketPrice
  returnSinceBuyPct?: number; // % ændring fra insiderens købspris til aktuel markedspris
  isTradingBelowInsiderPrice?: boolean; // true hvis aktuel kurs < insiderens købspris (kode P)
  ownershipNature?: 'D' | 'I'; // 'D' = Direct (personlige aktier), 'I' = Indirect (fond/LLC/trust). undefined = ukendt
  ownershipVia?: string; // Form 4 natureOfOwnership for indirekte køb, fx "By Sofinnova Venture Partners XI, L.P."
  issuerCik?: string; // udstederens CIK fra Form 4 (til udbudsopslag)
  offeringNote?: string; // "Mulig deltagelse i udbud: …" (kurs = udbudskurs ±7 dage, eller fodnote om udbud)
  offeringChecked?: boolean; // true = udbud er slået op for udstederen; undefined = ikke tjekket (ukendt)
  isExecutiveOfficer?: boolean; // true hvis CEO/CFO/COO/Pres/VP/GC/Chief/Counsel
  clusterPeers?: string[]; // Med-købere i samme selskab inden for samme tidsvindue
  clusterBuyers?: ClusterBuyer[]; // én post pr. distinkt køber i cluster-vinduet (inkl. lead)
  personalBuyers?: number; // købere med mindst én direkte (D) linje
  fundBuyers?: number; // købere udelukkende via fond/entity (I)
  exchange?: string; // f.eks. 'NASDAQ', 'NYSE', 'CPH (Nasdaq Copenhagen)', 'OTC'
  isTradableInDK?: boolean; // true = verificeret købbar på Nordnet/Saxo, false = afvist, undefined = ikke verificeret (data mangler)
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

/** En køber i et cluster (fonde og managing member i samme indberetning er én køber). */
export interface ClusterBuyer {
  name: string;
  title: string;
  ownership?: 'D' | 'I' | 'D+I'; // undefined = ukendt
  via?: string; // natureOfOwnership for de indirekte linjer
  valueUsd: number;
  tradeDate?: string;
  price?: number; // vægtet gennemsnit i `currency`
  currency?: string;
  offeringNote?: string;
}

export type FundamentalHealthBadge =
  | 'FORTRESS_BALANCE'
  | 'SOLID_RUNWAY'
  | 'SHORT_SQUEEZE_SETUP'
  | 'DILUTION_RISK'
  | 'NEUTRAL'
  | 'UNKNOWN'; // data mangler – må aldrig tolkes som et signal

export interface CompanyFundamentals {
  cashAndEquivalentsUsd?: number; // Kontanter + kortfristede værdipapirer i USD
  totalDebtUsd?: number; // Samlet kort- og langfristet gæld i USD
  netCashUsd?: number; // cashAndEquivalentsUsd - totalDebtUsd
  quarterlyCashBurnUsd?: number; // Kvartalsvist drifttab / negativt Operating Cash Flow i USD, hvis selskabet brænder penge
  estimatedRunwayMonths?: number | null; // Beregnet Cash Runway i måneder hvis cash burn > 0, ellers null hvis selskabet er cash-flow positivt!
  isCashFlowPositive?: boolean;
  shortPercentOfFloat?: number; // Procent af free float der er shortet, f.eks. 14.5
  daysToCover?: number; // Short ratio / dage til at dække shorts
  nextEarningsDate?: string; // ISO dato for NÆSTE kvartalsregnskab (aldrig i fortiden; undefined = ukendt)
  nextEarningsDateEstimated?: boolean; // true hvis datoen er et estimat (Nasdaq/Zacks), ikke bekræftet af selskabet
  daysUntilEarnings?: number; // Antal dage til regnskab (aldrig negativ)
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
  /** Forventet round-trip (køb + salg) efter config/costs.json; mangler ved ukendt marked/valuta. */
  cost?: {
    dkk: number;
    pct: number;
    orders: number; // købsordrer + én salgsordre
    minFeeBelowDkk: number; // under dette beløb pr. ordre slår minimumskurtagen igennem
    minFeeWarning: boolean;
    liquidityKnown: boolean; // false → værste spread-spand er brugt
  };
}

export type PaperTradeStatus = 'OPEN' | 'STOPPED_OUT' | 'TARGET_HIT' | 'CLOSED_MANUAL';

export type TradeType = 'PAPER' | 'REAL_NORDNET';

export type ExitSaleKind = 'DISCRETIONARY' | 'PLAN_10B5_1' | 'TEN_PCT_OWNER' | 'UNKNOWN';

export interface ExitSale {
  name: string;
  title: string;
  date: string; // handelsdato
  valueUsd: number;
  kind: ExitSaleKind; // 10b5-1-salg og 10 %-ejere udløser ikke alarm; UNKNOWN gør (forsigtighed)
}

/** NOT_CHECKED og NO_SALES er to forskellige tilstande: "ikke tjekket" er aldrig "0 salg". */
export type ExitRadarStatus = 'NOT_CHECKED' | 'NO_SALES' | 'SALES_FOUND' | 'ERROR' | 'UNSUPPORTED';

export interface InsiderExitWarning {
  status?: ExitRadarStatus; // mangler i positioner fra før fase 2 (= NOT_CHECKED)
  hasExit: boolean; // true = alarm (forbliver true, når første alarm er givet)
  checkedAt?: string;
  sales?: ExitSale[]; // salg siden openedAt ved seneste tjek
  firstAlertAt?: string; // første alarm gemmes permanent
  firstAlert?: ExitSale;
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
  openedScore?: number; // rådets score ved åbning – sættes én gang server-side og overskrives aldrig
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
  entryUsdDkk?: number; // USD/DKK ved entry – til SPY's afkast i DKK
  benchmarkTicker?: string; // default 'SPY'
  benchmarkEntryPrice?: number; // SPY-kurs ved entry (USD). undefined = ukendt → alpha "N/A"
  benchmarkCurrentPrice?: number; // aktuel SPY live kurs
  benchmarkReturnPct?: number | null; // SPY's afkast i DKK i samme periode. null = kan ikke beregnes
  alphaPct?: number | null; // positionens DKK-afkast minus SPY's DKK-afkast. null = "N/A"
  insiderExitWarning?: InsiderExitWarning;
  priceAlert?: 'STOP' | 'TARGET'; // kun REAL_NORDNET: advarsel – status ændres aldrig automatisk
  exitPrice?: number; // lukning: kurs i aktiens valuta
  exitFx?: number; // lukning: valutakurs til DKK
  closedAt?: string;
  realizedPnlDkk?: number;
  realizedPnlPct?: number;
}

/** Egne KPI'er for rigtige Nordnet-handler (fase 9): åbne + lukkede, i DKK. */
export interface RealKpis {
  openCount: number;
  closedCount: number;
  investedDkk: number; // al investeret kapital (åbne + lukkede)
  grossPnlDkk: number; // realiseret + urealiseret
  costsDkk: number; // kurtage + veksling efter tarif: køb (alle) + salg (lukkede)
  costsMissing: number; // positioner uden tarif for valutaen (tæller ikke med i costsDkk)
  netPnlDkk: number;
  netPnlPct: number | null; // null = intet investeret
  alphaPct: number | null; // vægtet efter investeret DKK over positioner med kendt alpha; null = ingen
  alphaCount: number;
}

export interface PortfolioSummary {
  tradeType: TradeType;
  totalInvestedDkk: number; // åbne positioner
  totalCurrentValueDkk: number; // åbne positioner til aktuel kurs
  unrealizedPnlDkk: number;
  realizedPnlDkk: number; // lukkede positioner
  totalPnlDkk: number; // urealiseret + realiseret
  totalPnlPct: number; // totalPnlDkk i forhold til al investeret kapital (åbne + lukkede)
  winRatePct: number | null; // kun lukkede positioner; null = ingen lukkede endnu
  openCount: number;
  closedCount: number;
  avgAlphaPct: number | null; // vægtet DKK-alpha for åbne positioner med kendt benchmark
  benchmarkReturnPct: number | null; // SPY i DKK i samme perioder (vægtet)
}

export type TrackRecordReputation =
  | 'SMART_MONEY_SNIPER'
  | 'CREDIBLE_BUYER'
  | 'FIRST_TIME_OR_RARE'
  | 'EARLY_OR_BAGHOLDER'
  | 'UNKNOWN'; // opslag fejlede eller ikke-US ticker – mangler data

export interface NotablePastTrade {
  date: string;
  insiderName: string;
  insiderTitle?: string;
  price: number;
  valueUsd: number;
  returnPct: number;
}

export interface TrackRecordStats {
  historicalBuysCount: number; // antal MÅLTE køb (ældre end horisonten)
  winRatePct: number;
  avgReturnPct: number; // gns. afkast over horisonten (ikke til dagens kurs)
}

export interface InsiderTrackRecord extends TrackRecordStats {
  // Felterne på øverste niveau er selskabets historik (alle insidere).
  reputation: TrackRecordReputation;
  reputationLabel: string;
  notablePastTrades: NotablePastTrade[]; // returnPct = afkast efter horisonten
  horizonTradingDays?: number; // fast måle-horisont (126 handelsdage ≈ 6 mdr.); mangler i domme fra før fase 2
  unmeasuredBuysCount?: number; // køb yngre end horisonten – ikke målt
  insiderOnly?: TrackRecordStats & { unmeasuredBuysCount: number }; // samme person som den aktuelle insider
  excludedOfferingBuys?: number; // køb i IPO/udbud (kurs = udbudskurs), udeladt som markedskøb; undefined = ikke tjekket
}

/** En række, scan-pipelinen afviste, med årsag (vises under "Vis afvist støj"). */
export interface RejectedRow {
  id: string;
  ticker: string;
  insiderName: string;
  reason: string;
}

export type AsymmetrySignal = 'HIGH' | 'MEDIUM' | 'LOW' | 'NOISE';

export interface GatekeeperResult {
  passedHardFilter: boolean;
  hardFilterReason?: string;
  // ponytail: historisk navn – feltet holder gatekeeper-scoren (0-100) fra alle providers (gemte scans bruger det)
  geminiPreScore: number;
  scoreSource: 'claude' | 'gemini' | 'heuristik'; // heuristiske scorer må ikke starte auto-køen (se isModelScore)
  asymmetrySignal: AsymmetrySignal;
  quickReasoning: string;
  usedFields?: string[]; // de payload-felter, modellen angav at have brugt (kun Claude)
}

/** Tokens og pris for gatekeeper-kaldene i én scan. */
export interface GatekeeperUsage {
  provider: 'claude' | 'gemini' | 'heuristik';
  model?: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd?: number; // undefined = pris ukendt for modellen
  truncatedChunks: number; // svar afskåret (stop_reason max_tokens / MAX_TOKENS)
  failedChunks: number; // chunks, hvor kaldet eller valideringen fejlede → heuristik
  heuristicCount: number; // kandidater, der endte med heuristisk score
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

export interface CouncilTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface CouncilVerdict {
  asymmetryScore: number; // 1-100
  verdict: CouncilVerdictType;
  headline: string;
  synthesis: string;
  reports: CouncilReports;
  timestamp: string;
  judgeThinking?: string; // kun det resumé, API'et faktisk returnerer
  modelsUsed?: CouncilModelsUsed;
  promptVersion?: string; // PROMPT_VERSION i claude-council.ts da dommen blev afsagt
  usage?: { specialists: CouncilTokenUsage; judge: CouncilTokenUsage };
  validated?: boolean; // true = dommerens output bestod skema-validering (fase 1); ældre domme mangler feltet
  legacyThinkingRemoved?: boolean; // opdigtet judgeThinking fjernet fra ældre dom (migration 4.11.2026)
  evaluatedAt?: string; // ISO tidsstempel for hvornår Rådet afsagde dommen
  priceAtEvaluation?: number; // aktiens markedskurs da dommen blev afsagt
  previousScore?: number; // hvis aktien bliver gen-vurderet, gem den forrige asymmetryScore så vi kan vise udviklingen, f.eks. 81 -> 85
}

/** Én række i radaren: transaktion + gatekeeperens resultat (UI). */
export interface ScanItem {
  transaction: InsiderTransaction;
  result: GatekeeperResult;
}

/** En gemt rådsdom med den transaktion, den blev afsagt på (UI). */
export interface SavedVerdictItem {
  transaction: InsiderTransaction;
  verdict: CouncilVerdict;
  savedAt: string;
}
