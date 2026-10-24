import Anthropic from '@anthropic-ai/sdk';
import { CouncilReports, CouncilVerdict, CouncilVerdictType, InsiderTransaction } from '@/types/insider';

const PRIMARY_MODEL = process.env.CLAUDE_MODEL || 'claude-3-7-sonnet-latest';
const FALLBACK_MODEL = 'claude-3-5-sonnet-20241022';

/**
 * Hjælpefunktion til kald af Claude med automatisk modelfallback.
 */
async function callClaude(
  client: Anthropic,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  try {
    const response = await client.messages.create({
      model: PRIMARY_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    return response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('\n');
  } catch (error: unknown) {
    console.warn(`Primær model ${PRIMARY_MODEL} afvist eller fejlede, skifter til ${FALLBACK_MODEL}:`, error);
    const fallbackResponse = await client.messages.create({
      model: FALLBACK_MODEL,
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
 * Genererer en hyper-realistisk simuleret rådsanalyse når ANTHROPIC_API_KEY mangler.
 */
function generateSimulatedCouncil(tx: InsiderTransaction): CouncilVerdict {
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
  };
}

/**
 * Samler "The Council" (3 parallelle specialist-agenter efterfulgt af The Judge) for en insider-transaktion.
 */
export async function conveneCouncil(tx: InsiderTransaction): Promise<CouncilVerdict> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Fallback til simuleret råd hvis API-nøgle ikke er angivet
  if (!apiKey || apiKey.trim() === '' || apiKey.includes('your-') || apiKey === 'placeholder') {
    return generateSimulatedCouncil(tx);
  }

  const client = new Anthropic({ apiKey });

  const txDetails = `
TICKER: ${tx.ticker} (${tx.companyName})
INSIDER: ${tx.insiderName}
ROLLE / TITEL: ${tx.insiderTitle}
TRANSAKTIONSTYPE: Kode ${tx.transactionCode} (Åbent markedskøb)
ANTAL AKTIER: ${tx.shares.toLocaleString()} stk a $${tx.pricePerShare} USD
TOTAL HANDELSVÆRDI: $${Math.round(tx.totalValueUsd).toLocaleString()} USD
BEHOLDNING EFTER KØB: ${tx.sharesOwnedFollowing.toLocaleString()} aktier
FORØGELSE AF EGEN BEHOLDNING: +${tx.holdingsIncreasePct}%
CLUSTER-KØB: ${tx.isClusterBuy ? `JA (${tx.clusterCount ?? 2} ledelsespersoner)` : 'NEJ'}
KURSUDVIKLING SENESTE 30 DAGE: ${tx.recentPriceChange30dPct !== undefined ? `${tx.recentPriceChange30dPct}%` : 'Ukendt'}
SEC FILING URL: ${tx.secFilingUrl}
KONTEKST / NOTER: ${tx.contextNotes || 'Ingen yderligere noter'}
  `.trim();

  // Specialist 1: The Insider Profiler
  const profilerSystem = `Du er "The Insider Profiler" i investeringsrådet The Council.
Din rolle er at dissekere personen og deres reelle motivation. Analyser rollen (CFO/General Counsel kender tallene/juraen; CEO har ofte PR-incitamenter) og conviction (holdingsIncreasePct og absolut dollarværdi).
Er dette et ægte "skin-in-the-game" træk med egne sparepenge eller blot kosmetisk signalværdi?
SKRIV PÅ DANSK. Maksimalt 140 ord. Skarp, direkte tone uden høflighedsfraser.`;

  // Specialist 2: The Catalyst & Asymmetry Hunter
  const catalystSystem = `Du er "The Catalyst & Asymmetry Hunter" i investeringsrådet The Council.
Din rolle er at analysere det grå felt mellem lovlig insider-akkumulering og endnu ikke-offentliggjort positiv information.
Hvorfor køber de NETOP NU? Er det overreaktion på et kursfald, accelererende ordrebog forud for regnskab, opkøbsrygter eller koordineret cluster-timing?
SKRIV PÅ DANSK. Maksimalt 140 ord. Skarp, analytisk tone.`;

  // Specialist 3: The Forensic Skeptic (Djævelens Advokat)
  const skepticSystem = `Du er "The Forensic Skeptic" (Djævelens Advokat) i investeringsrådet The Council.
Dit eneste mål er at DRÆBE købs-tesen og beskytte fondens kapital. Find alle svagheder: Er det et PR-stunt, en "faldende kniv" / value trap, likviditetsproblemer, eller forsøg på at skabe falsk tryghed før dårlige nyheder?
SKRIV PÅ DANSK. Maksimalt 140 ord. Nådesløs og kritisk.`;

  try {
    // Kør de 3 specialist-agenter 100% parallelt via Promise.all
    const [profilerReport, catalystReport, skepticReport] = await Promise.all([
      callClaude(client, profilerSystem, `Analyser følgende transaktion:\n\n${txDetails}`),
      callClaude(client, catalystSystem, `Analyser katalysator og asymmetri for følgende transaktion:\n\n${txDetails}`),
      callClaude(client, skepticSystem, `Kritiser og find svaghederne ved følgende transaktion:\n\n${txDetails}`),
    ]);

    const reports: CouncilReports = {
      profiler: profilerReport.trim(),
      catalyst: catalystReport.trim(),
      skeptic: skepticReport.trim(),
    };

    // 4. Dommer-agenten: The Judge (Chief Investment Officer)
    const judgeSystem = `Du er "The Judge" (Chief Investment Officer) for investeringsrådet The Council.
Du har modtaget 3 uafhængige rapporter fra dine specialister (Profiler, Catalyst, Skeptic) om en insider-transaktion.
Din opgave er at fælde den endelige, autoritative dom.

Du SKAL returnere et JSON-objekt med præcis denne struktur:
{
  "asymmetryScore": <nummer mellem 1 og 100>,
  "verdict": <præcis en af: "STRONG ASYMMETRY (KØB)" | "MODERATE SIGNAL (OVERVÅG)" | "PR STUNT / STØJ (IGNORER)">,
  "headline": "<en fængende, præcis overskrift på dansk om dommen>",
  "synthesis": "<en sammenfattende dom på 2-3 afsnit på dansk, der vejer de tre specialisters argumenter op mod hinanden og konkluderer entydigt>"
}

Regler for dommen:
- Hvis CFO/General Counsel køber markant (+15% beholdning) og/eller cluster-køb: Typisk score 80-98 og STRONG ASYMMETRY.
- Hvis CEO/insider køber for småpenge i forhold til formue (<2% stigning i beholdning): Typisk score <35 og PR STUNT / STØJ.
- Returner KUN ren JSON.`;

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

Fæld din endelige dom og returner KUN det specificerede JSON-objekt.`;

    const judgeRawResponse = await callClaude(client, judgeSystem, judgePrompt);

    // Parse JSON fra dommeren med robust regex-fallback
    let parsedJudge: {
      asymmetryScore: number;
      verdict: CouncilVerdictType;
      headline: string;
      synthesis: string;
    };

    try {
      const jsonMatch = judgeRawResponse.match(/\{[\s\S]*\}/);
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
        synthesis: judgeRawResponse,
      };
    }

    return {
      asymmetryScore: Math.min(Math.max(Math.round(parsedJudge.asymmetryScore || 50), 1), 100),
      verdict: parsedJudge.verdict || 'MODERATE SIGNAL (OVERVÅG)',
      headline: parsedJudge.headline,
      synthesis: parsedJudge.synthesis,
      reports,
      timestamp: new Date().toISOString(),
    };
  } catch (councilError) {
    console.warn('Fejl under kørsel af The Council via Claude API, skifter til simuleret råd:', councilError);
    return generateSimulatedCouncil(tx);
  }
}
