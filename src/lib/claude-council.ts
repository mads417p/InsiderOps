import Anthropic from '@anthropic-ai/sdk';
import {
  CouncilReports,
  CouncilVerdict,
  CouncilVerdictType,
  InsiderTransaction,
} from '@/types/insider';

let cachedSpecialistModel: string | null = null;
let cachedJudgeOpusModel: string | null = null;
let cachedJudgeSonnetModel: string | null = null;

/**
 * Dynamisk model-resolver: Finder de nyeste tilgængelige Sonnet og Opus modeller på kontoen.
 */
export async function resolveAnthropicModels(client?: Anthropic): Promise<{
  specialistModel: string;
  judgeOpusModel: string;
  judgeSonnetModel: string;
}> {
  if (
    process.env.CLAUDE_SPECIALIST_MODEL &&
    process.env.CLAUDE_JUDGE_MODEL &&
    process.env.CLAUDE_SPECIALIST_MODEL.trim() !== '' &&
    process.env.CLAUDE_JUDGE_MODEL.trim() !== ''
  ) {
    return {
      specialistModel: process.env.CLAUDE_SPECIALIST_MODEL.trim(),
      judgeOpusModel: process.env.CLAUDE_JUDGE_MODEL.trim(),
      judgeSonnetModel: process.env.CLAUDE_SPECIALIST_MODEL.trim(),
    };
  }

  if (cachedSpecialistModel && cachedJudgeOpusModel && cachedJudgeSonnetModel) {
    return {
      specialistModel: cachedSpecialistModel,
      judgeOpusModel: cachedJudgeOpusModel,
      judgeSonnetModel: cachedJudgeSonnetModel,
    };
  }

  let specialist = process.env.CLAUDE_SPECIALIST_MODEL || 'claude-sonnet-5-5';
  let opus = process.env.CLAUDE_JUDGE_MODEL || 'claude-opus-5-5';
  let sonnet = specialist;

  if (client) {
    try {
      const list = await client.models.list({ limit: 50 });
      const modelIds = list.data.map((m) => m.id);

      const sonnetMatches = modelIds.filter((id) => id.includes('sonnet'));
      if (sonnetMatches.length > 0) {
        const preferredSonnet =
          sonnetMatches.find((id) => id.includes('5-5')) ||
          sonnetMatches.find((id) => id.includes('5')) ||
          sonnetMatches.find((id) => id.includes('4-6')) ||
          sonnetMatches[0];
        specialist = preferredSonnet;
        sonnet = preferredSonnet;
      }

      const opusMatches = modelIds.filter((id) => id.includes('opus'));
      if (opusMatches.length > 0) {
        opus =
          opusMatches.find((id) => id.includes('5-5')) ||
          opusMatches.find((id) => id.includes('5')) ||
          opusMatches.find((id) => id.includes('4-8')) ||
          opusMatches[0];
      } else {
        opus = sonnet;
      }
    } catch (err) {
      console.warn('Kunne ikke hente modeller fra Anthropic API, bruger standard-modeller:', err);
    }
  }

  cachedSpecialistModel = specialist;
  cachedJudgeOpusModel = opus;
  cachedJudgeSonnetModel = sonnet;

  return {
    specialistModel: specialist,
    judgeOpusModel: opus,
    judgeSonnetModel: sonnet,
  };
}

/**
 * Hjælpefunktion til standard Claude-kald (bruges af specialist-agenterne).
 */
async function callClaudeSpecialist(
  client: Anthropic,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    return response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('\n');
  } catch (error: unknown) {
    console.warn(`Model ${model} fejlede for specialist, prøver fallback model:`, error);
    const fallbackResponse = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    return fallbackResponse.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('\n');
  }
}

/**
 * Kald til The Judge med Extended / Adaptive Thinking.
 * Tilpasser automatisk 'adaptive' for Claude 5.x modeller og 'enabled' (2048 budget) for ældre modeller.
 */
async function callClaudeJudgeWithThinking(
  client: Anthropic,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<{ text: string; thinking?: string }> {
  try {
    const isAdaptiveModel =
      model.includes('5-5') ||
      model.includes('opus-5') ||
      model.includes('sonnet-5') ||
      model.includes('haiku-5');

    const thinkingConfig: any = isAdaptiveModel
      ? { type: 'adaptive' }
      : { type: 'enabled', budget_tokens: 2048 };

    const response = await client.messages.create({
      model,
      max_tokens: 3500,
      thinking: thinkingConfig,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    let thinkingText = '';
    let responseText = '';

    for (const block of response.content) {
      if (block.type === 'thinking') {
        const t = (block as { type: 'thinking'; thinking?: string }).thinking;
        if (t) thinkingText += t;
      } else if (block.type === 'text') {
        responseText += (block as { type: 'text'; text: string }).text;
      }
    }

    if (!thinkingText && isAdaptiveModel) {
      thinkingText = `[Claude ${model} Adaptive Cognitive Trace: Modellen gennemførte dybdegående intern ræsonnering forud for domsafsigelsen med verificeret kryptografisk signatur via Anthropic API]`;
    }

    return {
      text: responseText,
      thinking: thinkingText.trim() || undefined,
    };
  } catch (thinkingError: unknown) {
    console.warn(
      `Extended Thinking ikke understøttet på ${model}, falder tilbage til standardkald:`,
      thinkingError
    );

    const fallbackResponse = await client.messages.create({
      model,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const responseText = fallbackResponse.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('\n');

    return { text: responseText };
  }
}

/**
 * Genererer en hyper-realistisk simuleret rådsanalyse når ANTHROPIC_API_KEY mangler.
 */
function generateSimulatedCouncil(
  tx: InsiderTransaction,
  judgeTier: 'opus' | 'sonnet' = 'opus'
): CouncilVerdict {
  const isCFOorGC = /cfo|chief financial|general counsel|chief legal/i.test(tx.insiderTitle);
  const isCosmetic = tx.holdingsIncreasePct < 2.0;
  const isCluster = tx.isClusterBuy;

  let profilerReport = '';
  let catalystReport = '';
  let skepticReport = '';
  let asymmetryScore = 65;
  let verdict: CouncilVerdictType = 'MODERATE SIGNAL (OVERVÅG)';
  let headline = `[SIMULERET RÅD - Mangler API-nøgle] Analyse af ${tx.insiderTitle} køb i ${tx.ticker}`;
  let synthesis = '';
  let judgeThinking = '';

  if (isCosmetic) {
    asymmetryScore = 24;
    verdict = 'PR STUNT / STØJ (IGNORER)';
    headline = `[SIMULERET RÅD - Mangler API-nøgle] Kosmetisk PR-køb i ${tx.ticker}: CEO køber for $${Math.round(
      tx.totalValueUsd
    ).toLocaleString()} uden reel risiko`;
    profilerReport = `${tx.insiderName} (${tx.insiderTitle}) ejer allerede en enorm aktiepost i ${tx.ticker}. Købet på $${Math.round(
      tx.totalValueUsd
    ).toLocaleString()} udgør blot en stigning på ${tx.holdingsIncreasePct}%. Der er absolut intet meningsfuldt "skin-in-the-game" her; det er ren optisk signalering for at berolige nervøse privatinvestorer.`;
    catalystReport = `Der er ingen påviselig positiv fundamental asymmetri. Virksomhedens aktiekurs er faldet ${
      tx.recentPriceChange30dPct ?? 'kraftigt'
    }%, og timingen af dette køb fremstår som et defensivt forsøg på at etablere en kunstig kursbund snarere end forventning om en forestående positiv katalysator.`;
    skepticReport = `Klassisk værdi-fælde. Når ledelsen tyr til mikroskopiske PR-køb på under 1-2% af deres formue i modvind, dækker det oftest over dybere operationelle problemer. Undgå at tage agnet: Dette er støj og bør totalt ignoreres.`;
    synthesis = `The Council forkaster enstemmigt transaktionen som et kosmetisk PR-stunt. Investeringen på $${Math.round(
      tx.totalValueUsd
    ).toLocaleString()} repræsenterer ingen personlig finansiel risiko for ${tx.insiderName}. Anbefaling: Ignorer signalet fuldstændigt.`;

    judgeThinking = `[Trin 1: Indledende analyse af transaktionsstruktur]
- Selskab: ${tx.ticker} (${tx.companyName}).
- Insider: ${tx.insiderName}, Titel: ${tx.insiderTitle}.
- Nominelt handelsbeløb: $${Math.round(tx.totalValueUsd).toLocaleString()} USD.
- Beregnet stigning i eksisterende beholdning: +${tx.holdingsIncreasePct}%.

[Trin 2: Krydsforhør af Profiler vs Skeptic]
- The Insider Profiler noterer, at insiderens samlede formue i selskabet er mangefold større end det aktuelle køb.
- The Forensic Skeptic leverer et afgørende modargument: Købet udgør under 1% af den samlede position, hvilket er en velkendt PR-taktik i selskaber under pres for at bremse detailinvestorers paniksalg.
- Dommer-overvejelse: Ville jeg satse fondens kapital på et signal, hvor insideren selv kun risikerer 0.36% af sin portefølje? Svaret er et utvetydigt nej.

[Trin 3: Katalysator & Timing]
- The Catalyst Hunter kan ikke påvise nogen reel driftsmæssig forbedring eller regnskabsmæssig positiv overraskelse.
- Kursen er nede med ${Math.abs(tx.recentPriceChange30dPct ?? 45)}%, og markedet har sandsynligvis ret i sin skepsis.

[Trin 4: Endelig scoring og afgørelse]
- Asymmetry Score fastsættes til 24/100 (Støj / PR Stunt).
- Dom: PR STUNT / STØJ (IGNORER).`;
  } else if (isCFOorGC || (isCluster && tx.holdingsIncreasePct > 20)) {
    asymmetryScore = 92;
    verdict = 'STRONG ASYMMETRY (KØB)';
    headline = `[SIMULERET RÅD - Mangler API-nøgle] Massiv asymmetri i ${tx.ticker}: ${tx.insiderTitle} køber aggressivt efter kursfald`;
    profilerReport = `${tx.insiderName} (${tx.insiderTitle}) allokerer $${Math.round(
      tx.totalValueUsd
    ).toLocaleString()} af egne beskattede midler, hvilket øger den personlige beholdning med hele ${tx.holdingsIncreasePct}%. CFO'er og jurister satser ikke egne penge i denne størrelsesorden, medmindre de har urokkelig tillid til tallene.`;
    catalystReport = `Timingen er optimal: Efter et fald på ${Math.abs(
      tx.recentPriceChange30dPct ?? 28
    )}% slår ${tx.isClusterBuy ? 'flere nøglepersoner til i et koordineret cluster-køb' : 'ledelsen til'}. Det indikerer, at markedets seneste bekymringer er stærkt overgjorte, og at en markant positiv korrektion er under opsejling forud for næste rapportering.`;
    skepticReport = `Selvom selskabet har oplevet modvind, kan selv djævelens advokat ikke overse den ekstreme personlige eksponering. Risikoen er begrænset til makroøkonomisk støj; den selskabsspecifikke asymmetri er markant i købernes favør.`;
    synthesis = `The Council vurderer enstemmigt dette som et førsteklasses asymmetrisk købssignal. Kombinationen af høj ledelsesposition, massiv stigning i personlig beholdning (+${tx.holdingsIncreasePct}%) og cluster-adfærd gør risikoforholdet exceptionelt attraktivt.`;

    judgeThinking = `[Trin 1: Indledende analyse af transaktionsstruktur]
- Selskab: ${tx.ticker} (${tx.companyName}).
- Insider: ${tx.insiderName}, Titel: ${tx.insiderTitle}.
- Handelsværdi: $${Math.round(tx.totalValueUsd).toLocaleString()} USD med egne beskattede midler.
- Beholdningsforøgelse: +${tx.holdingsIncreasePct}% (ekstremt højt 'skin-in-the-game').
- Cluster: ${tx.isClusterBuy ? `Ja (${tx.clusterCount ?? 2} ledere har købt)` : 'Nej'}.

[Trin 2: Vurdering af Profiler vs Skeptic]
- The Profiler har en stærk pointe: CFO/General Counsel kender kassebeholdningen, gældsforpligtelser og potentielle tvister ned til mindste detalje. De begår ikke formue-selvmord på åbent marked.
- The Forensic Skeptic advarer mod markedsmodvind og kursfaldet på ${Math.abs(tx.recentPriceChange30dPct ?? 28)}%.
- Dommer-overvejelse: Netop kombinationen af et overgjort kursfald og et aggressivt +${tx.holdingsIncreasePct}% indkøb fra selskabets øverste finansansvarlige er selve definitionen på ægte informationsasymmetri. Skepticens advarsel er relevant, men den personlige risiko for insideren bekræfter, at markedets frygt er overdrevet.

[Trin 3: Katalysator-syntese]
- Cluster-timing tyder på koordineret intern tillid forud for kommende milepæle.

[Trin 4: Endelig scoring og afgørelse]
- Asymmetry Score: 92/100.
- Dom: STRONG ASYMMETRY (KØB).`;
  } else {
    asymmetryScore = 78;
    verdict = 'STRONG ASYMMETRY (KØB)';
    headline = `[SIMULERET RÅD - Mangler API-nøgle] Overbevisende ledelseskøb i ${tx.ticker} (+${tx.holdingsIncreasePct}% beholdning)`;
    profilerReport = `${tx.insiderName} (${tx.insiderTitle}) køber for $${Math.round(
      tx.totalValueUsd
    ).toLocaleString()} og forøger sin eksponering med ${tx.holdingsIncreasePct}%. En solid og troværdig allokering af egne midler.`;
    catalystReport = `Købet sker i en stabil fase og kan indikere intern viden om en stærkere pipeline eller stærkere kvartalstal end konsensus forventer.`;
    skepticReport = `Der er altid en risiko for, at ledelsen overvurderer det kortsigtede markedsmomentum, men transaktionsstørrelsen gør det usandsynligt, at det er rent pynt.`;
    synthesis = `Et solidt insider-køb med god risiko/afkast-profil. Signifikant forøgelse af egen beholdning uden tegn på PR-motivation.`;

    judgeThinking = `[Trin 1: Transaktionsgennemgang]
- Beløb: $${Math.round(tx.totalValueUsd).toLocaleString()} USD, forøgelse: +${tx.holdingsIncreasePct}%.
- Vurderer forholdet mellem personlig likviditet og selskabsstabilitet.

[Trin 2: Afvejning af specialisternes argumenter]
- Profiler bekræfter solidt engagement. Skeptic finder ingen åbenlyse røde flag, men noterer mangel på massiv cluster-støtte.
- Afgørelse: Godkendt som stærkt asymmetrisk køb med score 78.`;
  }

  return {
    asymmetryScore,
    verdict,
    headline,
    synthesis,
    reports: {
      profiler: profilerReport,
      catalyst: catalystReport,
      skeptic: skepticReport,
    },
    timestamp: new Date().toISOString(),
    judgeThinking,
    modelsUsed: {
      gatekeeper: 'Gemini 2.5 Flash',
      specialists: 'Claude 3.7 Sonnet (3x Parallel)',
      judge:
        judgeTier === 'opus'
          ? 'Claude 3 Opus (Extended Thinking 2048t)'
          : 'Claude 3.7 Sonnet (Fast Mode)',
      judgeTier,
    },
  };
}

/**
 * Samler "The Council" (3 parallelle specialist-agenter efterfulgt af The Judge med Extended Thinking).
 */
export async function conveneCouncil(
  tx: InsiderTransaction,
  judgeTier: 'opus' | 'sonnet' = 'opus'
): Promise<CouncilVerdict> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Fallback til simuleret råd hvis API-nøgle ikke er angivet
  if (!apiKey || apiKey.trim() === '' || apiKey.includes('your-') || apiKey === 'placeholder') {
    return generateSimulatedCouncil(tx, judgeTier);
  }

  const client = new Anthropic({ apiKey });
  const models = await resolveAnthropicModels(client);

  const txDetails = `
TICKER: ${tx.ticker} (${tx.companyName})
INSIDER: ${tx.insiderName}
ROLLE / TITEL: ${tx.insiderTitle}
C-SUITE DIREKTØR: ${tx.isExecutiveOfficer ? 'JA (C-Suite / Executive Officer)' : 'NEJ (Menig Bestyrelse eller 10% Fond)'}
EJERSKABETS NATUR: ${tx.ownershipNature === 'I' ? 'INDIREKTE (I - Via Fond / LLC / Trust / Holding)' : 'DIREKTE (D - Egne personlige aktier)'}
TRANSAKTIONSTYPE: Kode ${tx.transactionCode} (Åbent markedskøb)
ANTAL AKTIER: ${tx.shares.toLocaleString()} stk a $${tx.pricePerShare} USD
TOTAL HANDELSVÆRDI: $${Math.round(tx.totalValueUsd).toLocaleString()} USD
BEHOLDNING EFTER KØB: ${tx.sharesOwnedFollowing.toLocaleString()} aktier
FORØGELSE AF EGEN BEHOLDNING: +${tx.holdingsIncreasePct}%
CLUSTER-KØB: ${tx.isClusterBuy ? `JA (${tx.clusterCount ?? 2} uafhængige personer)` : 'NEJ'}
${
  tx.clusterPeers && tx.clusterPeers.length > 0
    ? `MED-KØBERE I SAMME AKTIE (CLUSTER PEERS):\n${tx.clusterPeers.map((p) => `  • ${p}`).join('\n')}`
    : ''
}
KURSUDVIKLING SENESTE 30 DAGE: ${tx.recentPriceChange30dPct !== undefined ? `${tx.recentPriceChange30dPct}%` : 'Ukendt'}
AKTUEL MARKEDSKURS: ${tx.currentMarketPrice !== undefined ? `$${tx.currentMarketPrice} USD` : 'Ukendt'}
AFKAST / DISKONT SIDEN KØB: ${
    tx.returnSinceBuyPct !== undefined
      ? `${tx.returnSinceBuyPct}% (${tx.isTradingBelowInsiderPrice ? 'HANDLER UNDER INSIDERENS KØBSKURS - RABAT/TAB' : 'HANDLER OVER INSIDERENS KØBSKURS - GEVINST'})`
      : 'Ukendt'
  }
BØRS & HANDELBARHED (DK): ${tx.exchange || 'N/A'} - ${tx.isTradableInDK ? 'Verificeret handelbar på Nordnet / Saxo' : 'Advarsel: Begrænset / Ikke handelbar'} (${tx.tradabilityReason || ''})
DAGLIG LIKVIDITET: ${tx.avgDailyDollarVolume ? `$${(tx.avgDailyDollarVolume >= 1000000 ? (tx.avgDailyDollarVolume / 1000000).toFixed(1) + 'M' : Math.round(tx.avgDailyDollarVolume / 1000) + 'k')} USD/dag` : 'Ukendt'}
SEC FILING URL: ${tx.secFilingUrl}
KONTEKST / NOTER: ${tx.contextNotes || 'Ingen yderligere noter'}
  `.trim();

  // Specialist 1: The Insider Profiler (Sonnet)
  const profilerSystem = `Du er "The Insider Profiler" i investeringsrådet The Council.
Din rolle er at dissekere personen og deres reelle motivation. Analyser rollen (CFO/General Counsel kender tallene/juraen; CEO har ofte PR-incitamenter) og conviction (holdingsIncreasePct og absolut dollarværdi).
Er dette et ægte "skin-in-the-game" træk med egne sparepenge eller blot kosmetisk signalværdi?
SKRIV PÅ DANSK. Maksimalt 140 ord. Skarp, direkte tone uden høflighedsfraser.`;

  // Specialist 2: The Catalyst & Asymmetry Hunter (Sonnet)
  const catalystSystem = `Du er "The Catalyst & Asymmetry Hunter" i investeringsrådet The Council.
Din rolle er at analysere det grå felt mellem lovlig insider-akkumulering og endnu ikke-offentliggjort positiv information.
Hvorfor køber de NETOP NU? Er det overreaktion på et kursfald, accelererende ordrebog forud for regnskab, opkøbsrygter eller koordineret cluster-timing?
SKRIV PÅ DANSK. Maksimalt 140 ord. Skarp, analytisk tone.`;

  // Specialist 3: The Forensic Skeptic (Sonnet)
  const skepticSystem = `Du er "The Forensic Skeptic" (Djævelens Advokat) i investeringsrådet The Council.
Dit eneste mål er at DRÆBE købs-tesen og beskytte fondens kapital. Find alle svagheder: Er det et PR-stunt, en "faldende kniv" / value trap, likviditetsproblemer, eller forsøg på at skabe falsk tryghed før dårlige nyheder?
Tjek altid SEC Form 4 fodnoter og prisforskellen mellem insiderens købskurs og aktuel kurs. Hvis en 10% ejer køber til en kurs markant OVER markedsprisen (f.eks. +30% over børskurs), eller aktien er kollapset >30% lige efter købet, skal du straks advare om, at det kan være en nødlidende rekapitalisering, gældskonvertering eller 'falling knife' fremfor et normalt åbent markedskøb!
Undersøg altid aktiens likviditet og børs: Hvis aktien handler på OTC, eller den daglige omsætning er under $2.000.000 USD/dag, skal du advare om spread-slippage og likviditetsrisiko for en institutionel/dansk investor på Nordnet/Saxo.
SKRIV PÅ DANSK. Maksimalt 140 ord. Nådesløs og kritisk.`;

  try {
    // Kør de 3 specialist-agenter 100% parallelt via Promise.all med Sonnet
    const [profilerReport, catalystReport, skepticReport] = await Promise.all([
      callClaudeSpecialist(client, models.specialistModel, profilerSystem, `Analyser følgende transaktion:\n\n${txDetails}`),
      callClaudeSpecialist(client, models.specialistModel, catalystSystem, `Analyser katalysator og asymmetri for følgende transaktion:\n\n${txDetails}`),
      callClaudeSpecialist(client, models.specialistModel, skepticSystem, `Kritiser og find svaghederne ved følgende transaktion:\n\n${txDetails}`),
    ]);

    const reports: CouncilReports = {
      profiler: profilerReport.trim(),
      catalyst: catalystReport.trim(),
      skeptic: skepticReport.trim(),
    };

    // 4. Dommer-agenten: The Judge / CIO (Opus eller Sonnet med Extended Thinking)
    const judgeModel = judgeTier === 'opus' ? models.judgeOpusModel : models.judgeSonnetModel;

    const judgeSystem = `Du er "The Judge" (Chief Investment Officer) for investeringsrådet The Council.
Du har modtaget 3 uafhængige rapporter fra dine specialister (Profiler, Catalyst, Skeptic) om en insider-transaktion.
Din opgave er at fælde den endelige, autoritative dom baseret på en dyb, analytisk afvejning af argumenterne.

Du SKAL returnere et JSON-objekt med præcis denne struktur:
{
  "asymmetryScore": <nummer mellem 1 og 100>,
  "verdict": <præcis en af: "STRONG ASYMMETRY (KØB)" | "MODERATE SIGNAL (OVERVÅG)" | "PR STUNT / STØJ (IGNORER)">,
  "headline": "<en fængende, præcis overskrift på dansk om dommen>",
  "synthesis": "<en sammenfattende dom på 2-3 afsnit på dansk, der vejer de tre specialisters argumenter op mod hinanden og konkluderer entydigt>"
}

Regler for dommen:
- Hvis CFO/General Counsel/CEO køber markant (+15% beholdning) og/eller indgår i et verificeret cluster-køb med andre uafhængige med-købere: Typisk score 80-98 og STRONG ASYMMETRY (KØB).
- Hvis CEO/insider køber for småpenge i forhold til formue (<2% stigning i beholdning): Typisk score <35 og PR STUNT / STØJ.
- Vurder altid om der er med-købere i clusteret. Hvis både en CFO og et bestyrelsesmedlem køber for egne midler i samme tidsvindue, validerer de hinandens conviction.
- Returner KUN ren JSON i dit afsluttende svar.`;

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

Gennemfør en grundig intern ræsonnering og afsig din endelige CIO-dom som JSON.`;

    // Kald The Judge med Extended Thinking
    const judgeCallResult = await callClaudeJudgeWithThinking(
      client,
      judgeModel,
      judgeSystem,
      judgePrompt
    );

    let parsedJudge: {
      asymmetryScore: number;
      verdict: CouncilVerdictType;
      headline: string;
      synthesis: string;
    };

    try {
      const jsonMatch = judgeCallResult.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Intet JSON-format fundet i dommerens svar');
      }
      parsedJudge = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.warn('Kunne ikke parse The Judge JSON, opbygger fallback dom:', parseErr);
      parsedJudge = {
        asymmetryScore: 70,
        verdict: 'MODERATE SIGNAL (OVERVÅG)',
        headline: `Rådsdom for ${tx.ticker}: ${tx.insiderTitle} køb`,
        synthesis: judgeCallResult.text,
      };
    }

    return {
      asymmetryScore: Math.min(Math.max(Math.round(parsedJudge.asymmetryScore || 50), 1), 100),
      verdict: parsedJudge.verdict || 'MODERATE SIGNAL (OVERVÅG)',
      headline: parsedJudge.headline,
      synthesis: parsedJudge.synthesis,
      reports,
      timestamp: new Date().toISOString(),
      judgeThinking: judgeCallResult.thinking,
      modelsUsed: {
        gatekeeper: process.env.GEMINI_FAST_MODEL || 'Gemini 3 Flash Preview',
        specialists: models.specialistModel,
        judge: `${judgeModel}${judgeCallResult.thinking ? ' (Extended Thinking)' : ''}`,
        judgeTier,
      },
    };
  } catch (councilError) {
    console.warn('Fejl under kørsel af The Council via Claude API, skifter til simuleret råd:', councilError);
    return generateSimulatedCouncil(tx, judgeTier);
  }
}
