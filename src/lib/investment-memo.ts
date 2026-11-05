import type { CouncilVerdict, InsiderTransaction } from '@/types/insider';
import type { CostsConfig } from '@/lib/costs';
import type { LiveFxRates } from '@/lib/live-quote';
import { generateTradeExecutionPlan } from '@/lib/trade-planner';
import { formatCompactUsd } from '@/lib/fundamentals';
import { priceLabel, verdictLabel } from '@/lib/ui-labels';

// Flyttet uændret fra page.tsx (UI-redesign). Notatet er en eksport, ikke UI – derfor står emojis og versaler som før.

export const HOLD_NOTE =
  'I backtesten var 63 handelsdage den eneste horisont, der ikke var negativ netto (USA in-sample, ikke bekræftet). Sverige-holdout 63 dage: −2,48 % netto.';

export function generateInvestmentMemoMarkdown(
  tx: InsiderTransaction,
  verdict: CouncilVerdict,
  { maxCapitalDkk, fxRates, planOpts }: { maxCapitalDkk: number; fxRates: LiveFxRates | null; planOpts: { tranches?: boolean; costs?: CostsConfig } }
): string {
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

  return `# ANALYSENOTAT: ${tx.ticker} (${tx.companyName})
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

## 5. Rådet: dommerens afgørelse og asymmetri-score
**Afgørelse:** ${verdictLabel(verdict.verdict)}
**Asymmetri-score:** ${verdict.asymmetryScore}/100  
**Overskrift:** ${verdict.headline}  

### CIO Syntese (${verdict.modelsUsed?.judge || 'ukendt model'}):
${verdict.synthesis}

---

## 6. Kvantitativ Eksekverings- & Risikoplan (Frie Midler)
${(() => {
const plan = generateTradeExecutionPlan(tx, verdict, maxCapitalDkk, fxRates, planOpts);
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

### Ordre og omkostninger:
- **${plan.tranche2.shares > 0 ? 'Tranche 1' : 'Ordre'}:** ${plan.tranche1.description} • ${plan.tranche1.allocationDkk.toLocaleString()} DKK${
  plan.tranche2.shares > 0 ? `\n- **Tranche 2:** ${plan.tranche2.description} • ${plan.tranche2.allocationDkk.toLocaleString()} DKK` : ''
}
- **Forventet round-trip (costs.json):** ${plan.cost ? `${plan.cost.dkk.toLocaleString('da-DK')} kr. (${plan.cost.pct} %)` : 'mangler data'}${
  plan.cost?.minFeeWarning ? ` – under ca. ${plan.cost.minFeeBelowDkk.toLocaleString('da-DK')} kr. pr. ordre slår minimumskurtagen igennem` : ''
}
- **Holdeperiode:** ${HOLD_NOTE}`;
})()}

---

## 6. Specialisternes Rapporter (${verdict.modelsUsed?.specialists || 'ukendt model'})

### [Insider-profiløren]
${verdict.reports.profiler}

### [Katalysator-jægeren]
${verdict.reports.catalyst}

### [Den kritiske skeptiker]
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
}
