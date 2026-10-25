import { InsiderTransaction, CouncilVerdict, TradeExecutionPlan } from '@/types/insider';

const USD_TO_DKK = 6.9;
const SEK_TO_DKK = 0.65;

/**
 * Beregner en komplet kvantitativ eksekverings- og risikoplan baseret på 14-dages ATR volatilitet,
 * asymmetri-score, insiderens købskurs og brugerens allokeringsramme i DKK.
 */
export function generateTradeExecutionPlan(
  tx: InsiderTransaction,
  verdict: CouncilVerdict,
  maxCapitalDkk: number = 25000
): TradeExecutionPlan {
  // 1. Kapitalbeskyttelse: Afvis transaktioner med lav score eller PR-stunt
  if (verdict.asymmetryScore < 60 || verdict.verdict === 'PR STUNT / STØJ (IGNORER)') {
    return {
      status: 'DO_NOT_TRADE',
      reason: `Asymmetry Score er ${verdict.asymmetryScore}/100 (${verdict.verdict}). Rådet fraråder kapitalallokering for at beskytte frie midler.`,
      recommendedAllocationDkk: 0,
      recommendedAllocationUsd: 0,
      totalShares: 0,
      entryZoneMin: 0,
      entryZoneMax: 0,
      entryZoneLabel: 'Ingen handel (Beskyt kapital)',
      stopLossPrice: 0,
      stopLossRiskPct: 0,
      maxLossDkk: 0,
      targetPrice1: 0,
      targetReturnPct1: 0,
      riskRewardRatio: 0,
      tranche1: {
        shares: 0,
        price: 0,
        allocationDkk: 0,
        allocationUsd: 0,
        description: 'Ingen allokering',
      },
      tranche2: {
        shares: 0,
        price: 0,
        allocationDkk: 0,
        allocationUsd: 0,
        description: 'Ingen allokering',
      },
      volatilityTag: 'N/A',
    };
  }

  // 2. Valuta og kurser
  const isDkk = tx.ticker.endsWith('.CO') || tx.exchange?.includes('Copenhagen');
  const isSek = tx.ticker.endsWith('.ST') || tx.exchange?.includes('Stockholm');
  const fxToDkk = isDkk ? 1.0 : isSek ? SEK_TO_DKK : USD_TO_DKK;

  const currentPrice = tx.currentMarketPrice || tx.pricePerShare || 1.0;
  const insiderPrice = tx.pricePerShare || currentPrice;

  // 3. Volatilitet og 14-dages ATR
  const atr = tx.atr14d && tx.atr14d > 0 ? tx.atr14d : Number((currentPrice * 0.04).toFixed(2));
  const dailyVol =
    tx.dailyVolatilityPct && tx.dailyVolatilityPct > 0
      ? tx.dailyVolatilityPct
      : Number(((atr / currentPrice) * 100).toFixed(2));

  let volatilityTag = `Normal Volatilitet (${dailyVol}%/dag)`;
  if (dailyVol > 8.0) {
    volatilityTag = `Ekstrem Biotek Volatilitet (${dailyVol}%/dag)`;
  } else if (dailyVol > 5.5) {
    volatilityTag = `Høj Volatilitet (${dailyVol}%/dag)`;
  } else if (dailyVol < 2.5) {
    volatilityTag = `Lav / Defensiv Volatilitet (${dailyVol}%/dag)`;
  }

  // 4. Conviction- & Volatilitets-justeret Allokering
  let convictionMult = 0.4;
  if (verdict.asymmetryScore >= 85) {
    convictionMult = 1.0;
  } else if (verdict.asymmetryScore >= 75) {
    convictionMult = 0.7;
  }

  let volMult = 1.0;
  if (dailyVol > 8.0) {
    volMult = 0.6; // Kraftig nedskalering ved ekstrem volatilitet
  } else if (dailyVol > 5.5) {
    volMult = 0.75; // 25% nedskalering for at begrænse kronetabet ved stop-loss
  }

  const recommendedAllocationDkk = Math.round(maxCapitalDkk * convictionMult * volMult);
  const recommendedAllocationUsd = Math.round(recommendedAllocationDkk / fxToDkk);

  const priceInDkk = currentPrice * fxToDkk;
  const totalShares = Math.max(1, Math.floor(recommendedAllocationDkk / priceInDkk));

  // Opdel i Tranche 1 (60%) og Tranche 2 (40%)
  const tranche1Shares = Math.max(1, Math.floor(totalShares * 0.6));
  const tranche2Shares = Math.max(0, totalShares - tranche1Shares);

  const tranche1Dkk = Math.round(tranche1Shares * priceInDkk);
  const tranche2Dkk = Math.round(tranche2Shares * priceInDkk);

  // 5. Entry Zone
  const isBelowInsider = tx.isTradingBelowInsiderPrice || currentPrice < insiderPrice;
  let entryZoneLabel = '';
  let entryZoneMin = 0;
  let entryZoneMax = 0;

  if (isBelowInsider) {
    const discount = Math.abs(tx.returnSinceBuyPct || ((currentPrice - insiderPrice) / insiderPrice) * 100);
    entryZoneLabel = `💎 Discount Accumulation Zone (Handler ${discount.toFixed(1)}% under insiderens kurs)`;
    entryZoneMin = Number((currentPrice * 0.97).toFixed(2));
    entryZoneMax = Number(currentPrice.toFixed(2));
  } else {
    entryZoneLabel = `Market Momentum Zone (Følger insiderens retning @ $${insiderPrice})`;
    entryZoneMin = Number((currentPrice * 0.98).toFixed(2));
    entryZoneMax = Number((currentPrice * 1.02).toFixed(2));
  }

  // 6. Hard Invalidation / Stop-Loss Kurs
  // Reference kurs er den laveste af markedspris og insiderpris
  const refPrice = Math.min(currentPrice, insiderPrice);
  const rawStopLoss = refPrice - 2.5 * atr;

  // Sikkerhedsgrænser: Stop-loss må højst være -18% og mindst -7% fra aktuel kurs
  const maxLossPrice = currentPrice * 0.82; // -18%
  const minLossPrice = currentPrice * 0.93; // -7%

  let stopLossPrice = Number(Math.max(rawStopLoss, maxLossPrice).toFixed(2));
  if (stopLossPrice > minLossPrice) {
    stopLossPrice = Number(minLossPrice.toFixed(2));
  }

  const stopLossRiskPct = Number((((stopLossPrice - currentPrice) / currentPrice) * 100).toFixed(1));
  const maxLossDkk = Math.round(recommendedAllocationDkk * (Math.abs(stopLossRiskPct) / 100));

  // 7. Kursmål (Target 1) & Risk/Reward Ratio
  let targetPrice1: number;
  if (tx.resistanceHigh90d && tx.resistanceHigh90d > currentPrice * 1.15) {
    targetPrice1 = Number(tx.resistanceHigh90d.toFixed(2));
  } else {
    targetPrice1 = Number((currentPrice + 3.5 * atr).toFixed(2));
  }

  const targetReturnPct1 = Number((((targetPrice1 - currentPrice) / currentPrice) * 100).toFixed(1));
  const riskRewardRatio = Number((targetReturnPct1 / Math.abs(stopLossRiskPct)).toFixed(1));

  const currPrefix = isDkk ? 'DKK ' : isSek ? 'SEK ' : '$';

  return {
    status: 'ACTIVE_PLAN',
    recommendedAllocationDkk,
    recommendedAllocationUsd,
    totalShares,
    entryZoneMin,
    entryZoneMax,
    entryZoneLabel,
    stopLossPrice,
    stopLossRiskPct,
    maxLossDkk,
    targetPrice1,
    targetReturnPct1,
    riskRewardRatio,
    tranche1: {
      shares: tranche1Shares,
      price: currentPrice,
      allocationDkk: tranche1Dkk,
      allocationUsd: Math.round(tranche1Dkk / fxToDkk),
      description: `Tranche 1 (60%): ${tranche1Shares} aktier @ ${currPrefix}${currentPrice} (Markedsåbning / Limit)`,
    },
    tranche2: {
      shares: tranche2Shares,
      price: entryZoneMin,
      allocationDkk: tranche2Dkk,
      allocationUsd: Math.round(tranche2Dkk / fxToDkk),
      description: `Tranche 2 (40%): ${tranche2Shares} aktier @ ${currPrefix}${entryZoneMin} (Pullback ordrebog)`,
    },
    volatilityTag,
  };
}
