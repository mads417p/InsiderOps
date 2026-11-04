import Anthropic from '@anthropic-ai/sdk';
import {
  CouncilReports,
  CouncilTokenUsage,
  CouncilVerdict,
  CouncilVerdictType,
  InsiderTransaction,
} from '@/types/insider';
import { formatCompactUsd } from '@/lib/fundamentals';
import { UNTRUSTED_DATA_INSTRUCTION, untrusted } from '@/lib/prompt-safety';

/** Bump ved enhver ændring af prompts eller skema, så domme kan spores til den prompt, der lavede dem. */
export const PROMPT_VERSION = 'fase1-2026-11-04';

const VERDICTS: readonly CouncilVerdictType[] = [
  'STRONG ASYMMETRY (KØB)',
  'MODERATE SIGNAL (OVERVÅG)',
  'PR STUNT / STØJ (IGNORER)',
];

export type CouncilErrorReason =
  | 'MISSING_API_KEY'
  | 'API_ERROR'
  | 'MAX_TOKENS'
  | 'REFUSAL'
  | 'INVALID_JUDGE_OUTPUT';

/** Rådet kunne ikke afsige en gyldig dom. Der må ikke gemmes eller vises en dom. */
export class CouncilError extends Error {
  constructor(
    public readonly reason: CouncilErrorReason,
    message: string
  ) {
    super(message);
    this.name = 'CouncilError';
  }
}

type StreamParams = Parameters<Anthropic['messages']['stream']>[0];
type MessageLike = { stop_reason: string | null; content: Array<{ type: string; text?: string }> };

/** Kaster, hvis svaret ikke er færdigt (afskåret, afvist eller anden stop_reason end end_turn). */
export function assertCompleted(msg: Pick<MessageLike, 'stop_reason'>, role: string): void {
  if (msg.stop_reason === 'end_turn') return;
  if (msg.stop_reason === 'refusal') {
    throw new CouncilError('REFUSAL', `${role}: modellen afviste at svare (stop_reason refusal).`);
  }
  if (msg.stop_reason === 'max_tokens' || msg.stop_reason === 'model_context_window_exceeded') {
    throw new CouncilError('MAX_TOKENS', `${role}: svaret blev afskåret (stop_reason ${msg.stop_reason}).`);
  }
  throw new CouncilError('API_ERROR', `${role}: uventet stop_reason "${msg.stop_reason}".`);
}

/** Validerer dommerens JSON i kode (structured outputs garanterer ikke interval og ikke-tomme felter). */
export function validateJudgeOutput(raw: unknown): {
  asymmetryScore: number;
  verdict: CouncilVerdictType;
  headline: string;
  synthesis: string;
} {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fail = (why: string) => new CouncilError('INVALID_JUDGE_OUTPUT', `Dommerens svar er ugyldigt: ${why}`);

  const score = o.asymmetryScore;
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 100) {
    throw fail(`asymmetryScore skal være et heltal 0–100 (fik ${JSON.stringify(score)})`);
  }
  const verdict = VERDICTS.find(
    (v) => typeof o.verdict === 'string' && v.toUpperCase() === o.verdict.trim().toUpperCase()
  );
  if (!verdict) throw fail(`verdict er ikke en af de tre tilladte værdier (fik ${JSON.stringify(o.verdict)})`);
  const headline = typeof o.headline === 'string' ? o.headline.trim() : '';
  const synthesis = typeof o.synthesis === 'string' ? o.synthesis.trim() : '';
  if (!headline) throw fail('headline er tom');
  if (!synthesis) throw fail('synthesis er tom');

  return { asymmetryScore: score, verdict, headline, synthesis };
}

/** stop_reason-tjek + JSON.parse + skema-validering af dommerens svar. */
export function parseJudgeMessage(msg: MessageLike) {
  assertCompleted(msg, 'Dommer');
  const text = msg.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CouncilError('INVALID_JUDGE_OUTPUT', 'Dommerens svar er ikke gyldig JSON.');
  }
  return validateJudgeOutput(raw);
}

/**
 * Ét kaldspunkt for alle Claude-kald. Streaming er nødvendig: SDK'en afviser non-streaming ved max_tokens 32000.
 * Retry (429/529/5xx, eksponentiel backoff, samme model) klares af SDK'ens maxRetries.
 */
async function callModel(client: Anthropic, params: StreamParams, role: string): Promise<Anthropic.Message> {
  let msg: Anthropic.Message;
  try {
    msg = await client.messages.stream(params).finalMessage();
  } catch (err) {
    throw new CouncilError(
      'API_ERROR',
      `${role}: Claude-kaldet (${params.model}) fejlede efter retries: ${(err as Error).message}`
    );
  }
  assertCompleted(msg, role);
  return msg;
}

const textOf = (msg: Anthropic.Message) =>
  msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

const sumUsage = (msgs: Anthropic.Message[]): CouncilTokenUsage =>
  msgs.reduce(
    (acc, m) => ({
      inputTokens: acc.inputTokens + m.usage.input_tokens,
      outputTokens: acc.outputTokens + m.usage.output_tokens,
      cacheCreationInputTokens: acc.cacheCreationInputTokens + (m.usage.cache_creation_input_tokens ?? 0),
      cacheReadInputTokens: acc.cacheReadInputTokens + (m.usage.cache_read_input_tokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
  );

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    asymmetryScore: { type: 'integer', description: 'Heltal fra 0 til 100' },
    verdict: { type: 'string', enum: [...VERDICTS] },
    headline: { type: 'string' },
    synthesis: { type: 'string' },
  },
  required: ['asymmetryScore', 'verdict', 'headline', 'synthesis'],
  additionalProperties: false,
};

function describeTransaction(tx: InsiderTransaction): string {
  const tr = tx.trackRecord;
  const f = tx.fundamentals;

  const trackRecordSection = !tr
    ? 'HISTORISK TRACK RECORD: mangler data'
    : tr.reputation === 'UNKNOWN'
      ? `HISTORISK TRACK RECORD: mangler data (${tr.reputationLabel})`
      : `HISTORISK TRACK RECORD FOR INSIDEREN / LEDELSEN:
• Status & Omdømme: ${tr.reputationLabel}
• Tidligere registrerede Kode P køb (3-4 år): ${tr.historicalBuysCount} handler
• Historisk Win-Rate: ${tr.winRatePct}% (aktier der efterfølgende gav positivt afkast)
• Gennemsnitligt historisk afkast: ${tr.avgReturnPct > 0 ? '+' : ''}${tr.avgReturnPct}%
${
  tr.notablePastTrades.length > 0
    ? `• Udvalgte tidligere køb i samme aktie:\n${tr.notablePastTrades
        .map(
          (t) =>
            `  - [${t.date}] ${t.insiderName} (${t.insiderTitle || 'Insider'}) købte @ $${t.price} ($${Math.round(
              t.valueUsd
            ).toLocaleString()}) -> Nuværende afkast: ${t.returnPct > 0 ? '+' : ''}${t.returnPct}%`
        )
        .join('\n')}`
    : '• Ingen tidligere registrerede åbne markedskøb i selskabet de seneste 3 år (sjældent signal).'
}`;

  const fundamentalsSection = !f
    ? 'FUNDAMENTALE NØGLETAL: mangler data'
    : `FUNDAMENTALE NØGLETAL & SEC XBRL BALANCE:
• Sundhedsbadge: [${f.fundamentalHealthBadge}]${f.fundamentalHealthBadge === 'UNKNOWN' ? ' (data mangler – ikke et signal)' : ''}
• Opsummering: ${f.fundamentalSummary}
• Kontanter & Kortfristede Værdipapirer (SEC XBRL): ${formatCompactUsd(f.cashAndEquivalentsUsd)}
• Samlet Gæld (Kort- & Langfristet): ${formatCompactUsd(f.totalDebtUsd)}
• Netto Kassebeholdning (Net Cash): ${f.netCashUsd !== undefined ? `${f.netCashUsd >= 0 ? '+' : ''}${formatCompactUsd(f.netCashUsd)}` : 'mangler data'}
• Drifts Cash Flow & Kvartalsvis Burn: ${
        f.isCashFlowPositive === true
          ? 'POSITIV DRIFT (Selskabet er Cash-Flow Positivt)'
          : f.isCashFlowPositive === false && f.quarterlyCashBurnUsd
            ? `NEGATIV DRIFT (-${formatCompactUsd(f.quarterlyCashBurnUsd)}/kvartal i burn)`
            : 'mangler data'
      }
• Estimeret Kontant Runway: ${
        f.isCashFlowPositive === true
          ? 'Selvfinansierende (Cash-Flow Positiv)'
          : typeof f.estimatedRunwayMonths === 'number'
            ? `${f.estimatedRunwayMonths} måneder`
            : 'mangler data'
      }
• Short Interest (% af Free Float): ${f.shortPercentOfFloat !== undefined ? `${f.shortPercentOfFloat}%` : 'mangler data'}${
        (f.shortPercentOfFloat ?? 0) >= 10 ? ' (HØJ SHORT-INTERESSE - SQUEEZE KANDIDAT)' : ''
      }
• Dage til at dække shorts (Days to Cover / Short Ratio): ${f.daysToCover ?? 'mangler data'}
• Næste regnskab (Earnings): ${
        f.nextEarningsDate
          ? `${f.nextEarningsDate}${f.nextEarningsDateEstimated ? ' (estimeret)' : ''}${
              f.daysUntilEarnings !== undefined ? ` – om ${f.daysUntilEarnings} dage` : ''
            }`
          : 'mangler data'
      }
• Værdiansættelse: P/E: ${f.peRatio ?? 'N/A (Negativ indtjening eller mangler data)'} | P/B: ${f.priceToBook ?? 'mangler data'}`;

  const tradability =
    tx.isTradableInDK === true
      ? 'Verificeret handelbar på Nordnet / Saxo'
      : tx.isTradableInDK === false
        ? 'Advarsel: Ikke handelbar i DK'
        : 'Ikke verificeret – data mangler';

  return `
TICKER: ${tx.ticker} (${tx.companyName})
INSIDER: ${tx.insiderName}
ROLLE / TITEL: ${tx.insiderTitle}
C-SUITE DIREKTØR: ${tx.isExecutiveOfficer ? 'JA (C-Suite / Executive Officer)' : 'NEJ (Menig Bestyrelse eller 10% Fond)'}
EJERSKABETS NATUR: ${tx.ownershipNature === 'I' ? 'INDIREKTE (I - Via Fond / LLC / Trust / Holding)' : 'DIREKTE (D - Egne personlige aktier)'}
RULE 10b5-1 HANDELSPLAN: ${tx.is10b51Plan ? 'JA (Forudbestemt automatisk handelsplan - 0% aktuel asymmetri/skøn)' : 'NEJ (Frivilligt, skønsmæssigt køb på åbent marked)'}
${tx.footnotesSummary ? `SEC FORM 4 FODNOTER / DET MED SMÅT:\n${untrusted('sec-form4-fodnoter', tx.footnotesSummary)}\n` : ''}TRANSAKTIONSTYPE: Kode ${tx.transactionCode} (Åbent markedskøb)
ANTAL AKTIER: ${tx.shares.toLocaleString()} stk a $${tx.pricePerShare} USD
TOTAL HANDELSVÆRDI: $${Math.round(tx.totalValueUsd).toLocaleString()} USD
BEHOLDNING EFTER KØB: ${tx.sharesOwnedFollowing !== undefined ? `${tx.sharesOwnedFollowing.toLocaleString()} aktier` : 'ikke oplyst'}
FORØGELSE AF EGEN BEHOLDNING: ${tx.holdingsIncreasePct !== undefined ? `+${tx.holdingsIncreasePct}%` : 'ukendt'}
CLUSTER-KØB: ${tx.isClusterBuy ? `JA (${tx.clusterCount ?? 2} uafhængige personer)` : 'NEJ'}
${
  tx.clusterPeers && tx.clusterPeers.length > 0
    ? `MED-KØBERE I SAMME AKTIE (CLUSTER PEERS):\n${tx.clusterPeers.map((p) => `  • ${p}`).join('\n')}`
    : ''
}
KURSUDVIKLING SENESTE 30 DAGE: ${tx.recentPriceChange30dPct !== undefined ? `${tx.recentPriceChange30dPct}%` : 'mangler data'}
AKTUEL MARKEDSKURS: ${tx.currentMarketPrice !== undefined ? `$${tx.currentMarketPrice} USD` : 'mangler data'}
AFKAST / DISKONT SIDEN KØB: ${
    tx.returnSinceBuyPct !== undefined
      ? `${tx.returnSinceBuyPct}% (${tx.isTradingBelowInsiderPrice ? 'HANDLER UNDER INSIDERENS KØBSKURS - RABAT/TAB' : 'HANDLER OVER INSIDERENS KØBSKURS - GEVINST'})`
      : 'mangler data'
  }
${trackRecordSection}
${fundamentalsSection}
BØRS & HANDELBARHED (DK): ${tx.exchange || 'mangler data'} - ${tradability}${tx.tradabilityReason ? ` (${tx.tradabilityReason})` : ''}
DAGLIG LIKVIDITET: ${tx.avgDailyDollarVolume ? `$${tx.avgDailyDollarVolume >= 1000000 ? (tx.avgDailyDollarVolume / 1000000).toFixed(1) + 'M' : Math.round(tx.avgDailyDollarVolume / 1000) + 'k'} USD/dag` : 'mangler data'}
SEC FILING URL: ${tx.secFilingUrl}
KONTEKST / NOTER:
${tx.contextNotes ? untrusted('kontekst-noter', tx.contextNotes) : 'Ingen yderligere noter'}
  `.trim();
}

const PROFILER_SYSTEM = `Du er "The Insider Profiler" i investeringsrådet The Council.
Din rolle er at dissekere personen og deres reelle motivation. Analyser rollen (CFO/General Counsel kender tallene/juraen; CEO har ofte PR-incitamenter) og conviction (holdingsIncreasePct og absolut dollarværdi).
Inddrag altid insiderens historiske track record: Er personen/ledelsen en 'Smart Money Sniper' med en dokumenteret win-rate over 65-80% og massive afkast på tidligere køb? Eller er det første gang i flere år, at ledelsen køber (et sjældent og stærkt signal)? Står der "mangler data", ved vi intet – gæt ikke.
Er dette et ægte "skin-in-the-game" træk med egne sparepenge eller blot kosmetisk signalværdi?
${UNTRUSTED_DATA_INSTRUCTION}
SKRIV PÅ DANSK. Maksimalt 140 ord. Skarp, direkte tone uden høflighedsfraser.`;

const CATALYST_SYSTEM = `Du er "The Catalyst & Asymmetry Hunter" i investeringsrådet The Council.
Din rolle er at analysere det grå felt mellem lovlig insider-akkumulering og endnu ikke-offentliggjort positiv information.
Hvorfor køber de NETOP NU? Er det overreaktion på et kursfald, accelererende ordrebog forud for regnskab, opkøbsrygter eller koordineret cluster-timing?
Vurder aktivt selskabets Short Interest (shortPercentOfFloat & daysToCover): Hvis 10-15%+ af floaten er shortet, og en insider køber massivt i et selskab med sund kasse/runway, er der et potentielt eksplosivt Short-Squeeze setup! Short-sælgere kan blive fanget og tvunget til panik-dækning.
Tjek regnskabskalenderen (næste regnskab): Køber insideren lige efter et regnskabs-dip, eller køber de med timing lige op til en rapport?
Står der "mangler data", ved vi intet om det punkt – byg ikke en tese på det.
${UNTRUSTED_DATA_INSTRUCTION}
SKRIV PÅ DANSK. Maksimalt 140 ord. Skarp, analytisk tone.`;

const SKEPTIC_SYSTEM = `Du er "The Forensic Skeptic" (Djævelens Advokat) i investeringsrådet The Council.
Dit eneste mål er at DRÆBE købs-tesen og beskytte fondens kapital. Find alle svagheder: Er det et PR-stunt, en "faldende kniv" / value trap, likviditetsproblemer, eller forsøg på at skabe falsk tryghed før dårlige nyheder?
Tjek insiderens historiske track record: Hvis status er 'EARLY_OR_BAGHOLDER', eller tidligere køb viser negative afkast (-20% til -50%), skal du straks advare mod, at ledelsen lider af confirmation bias, har elendig timing og gentagne gange griber faldende knive uden kontakt med markedsrealiteterne!
Tjek altid om handlen er gennemført under en Rule 10b5-1 forudbestemt automatisk handelsplan eller ifølge SEC-fodnoter er skemalagt lang tid forvejen. Hvis det er en 10b5-1 plan, skal du NÅDESLØST afvise den som 0% overbevisning og automatisk maskin-eksekvering uden aktuel informationsasymmetri!
Tjek altid SEC Form 4 fodnoter og prisforskellen mellem insiderens købskurs og aktuel kurs. Hvis en 10% ejer køber til en kurs markant OVER markedsprisen (f.eks. +30% over børskurs), eller aktien er kollapset >30% lige efter købet, skal du straks advare om, at det kan være en nødlidende rekapitalisering, gældskonvertering eller 'falling knife' fremfor et normalt åbent markedskøb!
Du må IKKE gætte løst på emissionsrisiko! Brug de faktiske SEC XBRL-balancetal (cash, gæld, kvartalsvis burn og runway):
- Hvis selskabet brænder penge og har under 9 måneders runway (fundamentalHealthBadge = 'DILUTION_RISK'), skal du HÅRDT ALARMERE om akut overhængende risiko for aktieudvanding, giftige konvertible lån eller tvungen fortegningsemission!
- Hvis selskabet derimod er Cash-Flow Positivt eller har en 'FORTRESS_BALANCE' med >24 måneders kontant runway og nul/lav gæld, SKAL du anerkende dette og utvetydigt FRIKENDE selskabet for udvandingsrisiko!
- Står balancen som "mangler data" eller badge 'UNKNOWN', er udvandingsrisikoen UKENDT: sig det, og frikend ikke.
Undersøg altid aktiens likviditet og børs: Hvis aktien handler på OTC, eller den daglige omsætning er under $2.000.000 USD/dag, skal du advare om spread-slippage og likviditetsrisiko for en institutionel/dansk investor på Nordnet/Saxo. Er handelbarheden "Ikke verificeret", så påpeg det.
${UNTRUSTED_DATA_INSTRUCTION}
SKRIV PÅ DANSK. Maksimalt 140 ord. Nådesløs og kritisk.`;

const JUDGE_SYSTEM = `Du er "The Judge" (Chief Investment Officer) for investeringsrådet The Council.
Du har modtaget 3 uafhængige rapporter fra dine specialister (Profiler, Catalyst, Skeptic) om en insider-transaktion.
Din opgave er at fælde den endelige, autoritative dom baseret på en dyb, analytisk afvejning af argumenterne.

Svar med et JSON-objekt med felterne:
- "asymmetryScore": heltal fra 0 til 100
- "verdict": præcis en af "STRONG ASYMMETRY (KØB)", "MODERATE SIGNAL (OVERVÅG)", "PR STUNT / STØJ (IGNORER)"
- "headline": en præcis overskrift på dansk om dommen
- "synthesis": en sammenfattende dom på 2-3 afsnit på dansk, der vejer de tre specialisters argumenter op mod hinanden og konkluderer entydigt

Regler for dommen:
- Hvis handlen er udført under en Rule 10b5-1 automatisk forudbestemt handelsplan: Sæt altid Asymmetry Score under 25 og dommen til "PR STUNT / STØJ (IGNORER)", da der er 0% aktuel informationsasymmetri eller skønsmæssigt engagement fra insideren.
- Historisk Track Record: Hvis insideren/ledelsen er en verificeret 'SMART_MONEY_SNIPER' (win-rate >= 65% og positiv historisk alpha), forstærk overbevisningen og løft Asymmetry Scoren (typisk 85-98), da insideren har bevist timing-disciplin. Hvis insideren derimod er en 'EARLY_OR_BAGHOLDER' (køber gentagne gange i minus), skal Asymmetry Scoren reduceres markant, og du skal advare mod kronisk dårlig timing og faldende knive. Hvis status er 'FIRST_TIME_OR_RARE' (første køb i >3 år), understreg det sjældne og potentielt stærke asymmetriske regimeskift.
- Hvis CFO/General Counsel/CEO køber markant (+15% beholdning) og/eller indgår i et verificeret cluster-køb med andre uafhængige med-købere: Typisk score 80-98 og STRONG ASYMMETRY (KØB).
- Fundamental Balance Sheet & Cash Runway:
  * Hvis fundamentalHealthBadge er 'DILUTION_RISK' (selskabets kontante runway er under 9 måneder og selskabet brænder penge), SKAL Asymmetry Scoren reduceres til under 50 og dommen sænkes til PR STUNT / STØJ eller MODERATE SIGNAL, da forestående aktieudvanding eller kapitalrejsning truer aktionærerne uanset insiderens optimisme.
  * Hvis fundamentalHealthBadge er 'SHORT_SQUEEZE_SETUP' (short float >= 12% kombineret med solid kassebeholdning/runway), forstærkes det asymmetriske potentiale mod toppen (typisk score 88-98 og STRONG ASYMMETRY), da insiderkøb i en tungt shortet aktie kan antænde en voldsom short squeeze.
  * Hvis selskabet har en 'FORTRESS_BALANCE' (rigelig net cash, >24 mdr. runway eller positiv cash-flow), frikend selskabet for konkurs/emissionsfrygt og beløn signalet med ekstra overbevisning.
- Ukendte data: Står et punkt som "mangler data", "Ikke verificeret" eller 'UNKNOWN' (badge eller omdømme), ved vi intet om det. Det er hverken et positivt eller negativt signal og må ikke løfte scoren. Nævn i syntesen, hvad der mangler.
- Hvis CEO/insider køber for småpenge i forhold til formue (<2% stigning i beholdning): Typisk score <35 og PR STUNT / STØJ.
- Vurder altid om der er med-købere i clusteret. Hvis både en CFO og et bestyrelsesmedlem køber for egne midler i samme tidsvindue, validerer de hinandens conviction.
${UNTRUSTED_DATA_INSTRUCTION}`;

/**
 * Samler "The Council": 3 parallelle specialister efterfulgt af dommeren med adaptive thinking og structured output.
 * Fejler noget, kastes CouncilError – der findes ingen simuleret eller fallback-dom.
 */
export async function conveneCouncil(
  tx: InsiderTransaction,
  judgeTier: 'opus' | 'sonnet' = 'opus'
): Promise<CouncilVerdict> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || apiKey.includes('your-') || apiKey === 'placeholder') {
    throw new CouncilError(
      'MISSING_API_KEY',
      'ANTHROPIC_API_KEY mangler i .env.local – rådet kan ikke samles, og der gemmes ingen dom.'
    );
  }

  const client = new Anthropic({ apiKey, maxRetries: 2 }); // maks 3 forsøg pr. kald
  const specialistModel = process.env.CLAUDE_SPECIALIST_MODEL?.trim() || 'claude-sonnet-5-5';
  const judgeModel =
    judgeTier === 'opus' ? process.env.CLAUDE_JUDGE_MODEL?.trim() || 'claude-opus-5-5' : specialistModel;

  const txDetails = describeTransaction(tx);
  const specialist = (system: string, task: string, role: string) =>
    callModel(
      client,
      {
        model: specialistModel,
        max_tokens: 16000,
        system,
        messages: [{ role: 'user', content: `${task}\n\n${txDetails}` }],
      },
      role
    );

  const specialistMsgs = await Promise.all([
    specialist(PROFILER_SYSTEM, 'Analyser følgende transaktion:', 'Profiler'),
    specialist(CATALYST_SYSTEM, 'Analyser katalysator og asymmetri for følgende transaktion:', 'Catalyst'),
    specialist(SKEPTIC_SYSTEM, 'Kritiser og find svaghederne ved følgende transaktion:', 'Skeptic'),
  ]);

  const reports: CouncilReports = {
    profiler: textOf(specialistMsgs[0]),
    catalyst: textOf(specialistMsgs[1]),
    skeptic: textOf(specialistMsgs[2]),
  };

  const judgePrompt = `Her er data for transaktionen:
${txDetails}

SPECIALIST-RAPPORTER:
---
[THE INSIDER PROFILER]:
${reports.profiler}
---
[THE CATALYST & ASYMMETRY HUNTER]:
${reports.catalyst}
---
[THE FORENSIC SKEPTIC]:
${reports.skeptic}
---

Afsig din endelige CIO-dom.`;

  const judgeMsg = await callModel(
    client,
    {
      model: judgeModel,
      max_tokens: 32000,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { format: { type: 'json_schema', schema: JUDGE_SCHEMA } },
      system: JUDGE_SYSTEM,
      messages: [{ role: 'user', content: judgePrompt }],
    },
    'Dommer'
  );
  const judged = parseJudgeMessage(judgeMsg);

  // Kun det, API'et faktisk returnerer – ingen opdigtet tekst, hvis thinking-resuméet er tomt.
  const judgeThinking = judgeMsg.content
    .filter((b): b is Anthropic.ThinkingBlock => b.type === 'thinking')
    .map((b) => b.thinking)
    .join('\n')
    .trim();

  return {
    ...judged,
    reports,
    timestamp: new Date().toISOString(),
    judgeThinking: judgeThinking || undefined,
    modelsUsed: {
      gatekeeper: process.env.GEMINI_FAST_MODEL || 'Gemini 3 Flash Preview',
      specialists: specialistModel,
      judge: judgeModel,
      judgeTier,
    },
    promptVersion: PROMPT_VERSION,
    usage: { specialists: sumUsage(specialistMsgs), judge: sumUsage([judgeMsg]) },
    validated: true,
  };
}
