import { FinishReason, GoogleGenAI, ThinkingLevel, Type, type ThinkingConfig } from '@google/genai';
import { applyHardFilter } from '@/lib/sec-scanner';
import { GatekeeperResult, InsiderTransaction } from '@/types/insider';
import { UNTRUSTED_DATA_INSTRUCTION, untrusted } from '@/lib/prompt-safety';

const clampScore = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

// Batch-scoring: lav thinking og højere output-loft, så svaret ikke afskæres.
// Thinking-tokens tæller med i maxOutputTokens; med 12 tickers, standard-thinking og 4096 tokens blev JSON'en klippet.
// ponytail: 10 pr. kald (ikke 5) – nøglen er på Free Tier (5 kald/min, 20 kald/dag); mindre chunks brugte kvoten op.
// Sæt ned til 5, hvis en betalt nøgle tages i brug og afskæringer dukker op igen.
export const GATEKEEPER_CHUNK_SIZE = 10;
const GATEKEEPER_MAX_OUTPUT_TOKENS = 8192;

/** retryDelay i sekunder fra et Gemini 429/RESOURCE_EXHAUSTED-svar; undefined, hvis fejlen ikke er en kvotefejl. */
export function geminiRetryDelaySec(err: unknown): number | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/\b429\b|RESOURCE_EXHAUSTED/.test(msg)) return undefined;
  const m = msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Number(m[1]) : 60;
}

/**
 * Kort ventetid (minutgrænsen, ≤ 30 s) → vent og prøv igen (højst 2 gange).
 * Lang ventetid (dagsgrænsen) → kald onExhausted og kast, så resten af scannen ikke bruger flere kald.
 */
export async function withGeminiQuotaRetry<T>(fn: () => Promise<T>, onExhausted: () => void): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const delay = geminiRetryDelaySec(err);
      if (delay !== undefined && delay <= 30 && attempt < 3) {
        await new Promise((r) => setTimeout(r, (delay + 1) * 1000));
        continue;
      }
      if (delay !== undefined && delay > 30) {
        onExhausted();
        throw new Error(`Gemini-kvoten er opbrugt (Free Tier: 20 kald/dag) – nulstilles om ca. ${Math.round(delay / 3600)} t`);
      }
      throw err;
    }
  }
}

type BatchItem = { id: string; geminiPreScore: number; asymmetrySignal: GatekeeperResult['asymmetrySignal']; quickReasoning: string };

/** Parser batch-svaret. Ugyldig eller afskåret JSON kaster med en tydelig fejl (logges af kalderen). */
export function parseGatekeeperBatch(text: string | undefined): BatchItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || '');
  } catch (err) {
    throw new Error(`Gemini-svaret er ikke gyldig JSON (sandsynligvis afskåret): ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('Gemini-svaret er ikke et JSON-array');
  return parsed as BatchItem[];
}

/** Lav thinking: Gemini 3 bruger thinkingLevel, 2.x bruger thinkingBudget (0 = slået fra). */
export function lowThinkingConfig(model: string): ThinkingConfig {
  return /gemini-2\./.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: ThinkingLevel.LOW };
}

const DEFAULT_MODEL = 'gemini-3-flash-preview';
let cachedGeminiFlashModel: string | null = null;

/**
 * Auto-resolver for nyeste tilgængelige Gemini Flash model på nøglen.
 */
export async function resolveGeminiFlashModel(ai?: GoogleGenAI): Promise<string> {
  if (process.env.GEMINI_FAST_MODEL && process.env.GEMINI_FAST_MODEL.trim() !== '') {
    return process.env.GEMINI_FAST_MODEL.trim();
  }
  if (cachedGeminiFlashModel) {
    return cachedGeminiFlashModel;
  }

  let chosen = DEFAULT_MODEL;

  if (ai) {
    try {
      const list = await ai.models.list();
      const names: string[] = [];
      for await (const m of list) {
        if (m.name) names.push(m.name.replace(/^models\//, ''));
      }
      const flashModels = names.filter(
        (n) => n.includes('flash') && !n.includes('image') && !n.includes('tts')
      );
      if (flashModels.length > 0) {
        const preferred =
          flashModels.find((n) => n === 'gemini-3-flash-preview') ||
          flashModels.find((n) => n.includes('3.8-flash')) ||
          flashModels.find((n) => n.includes('3.5-flash')) ||
          flashModels.find((n) => n.includes('2.5-flash')) ||
          flashModels[0];
        chosen = preferred;
      }
    } catch {
      // Brug standard fallback
    }
  }

  cachedGeminiFlashModel = chosen;
  return chosen;
}

/**
 * Deterministisk heuristisk score til test og fallback når GEMINI_API_KEY ikke er tilgængelig.
 */
function evaluateHeuristicGatekeeper(tx: InsiderTransaction): GatekeeperResult {
  const isCFOorGC = /cfo|chief financial|general counsel|chief legal|jurist/i.test(tx.insiderTitle);
  // Ukendt beholdningsstigning er hverken kosmetisk eller stærk.
  const isCosmetic = tx.holdingsIncreasePct !== undefined && tx.holdingsIncreasePct < 2.0;
  const isStrongIncrease = tx.holdingsIncreasePct !== undefined && tx.holdingsIncreasePct >= 15.0;
  const isCluster = tx.isClusterBuy;
  const isLargeValue = tx.totalValueUsd >= 250000;
  const hadPriceDrop = (tx.recentPriceChange30dPct ?? 0) <= -15.0;

  // Håndter Rule 10b5-1 automatiske handelsplaner (0% aktuel asymmetri)
  if (tx.is10b51Plan) {
    return {
      passedHardFilter: true,
      geminiPreScore: 16,
      scoreSource: 'heuristik',
      asymmetrySignal: 'NOISE',
      quickReasoning:
        'Rule 10b5-1 automatisk handelsplan: Handlen er forudbestemt måneder i forvejen via en fast algoritme og reflekterer ingen aktuel informationsasymmetri.',
    };
  }

  // Håndter kosmetiske PR-køb
  if (isCosmetic) {
    return {
      passedHardFilter: true,
      geminiPreScore: 24,
      scoreSource: 'heuristik',
      asymmetrySignal: 'LOW',
      quickReasoning: `Kosmetisk PR-køb: Selvom beløbet er $${Math.round(tx.totalValueUsd).toLocaleString()}, forøges insiderens samlede beholdning kun med ${tx.holdingsIncreasePct}%, hvilket tyder på symbolsk signalværdi frem for reel asymmetri.`,
    };
  }

  let score = 50;

  if (isCFOorGC) score += 20;
  if (isStrongIncrease) score += 15;
  if (isCluster) score += 15;
  if (hadPriceDrop) score += 10;
  if (isLargeValue) score += 5;

  score = clampScore(score);

  let asymmetrySignal: GatekeeperResult['asymmetrySignal'] = 'LOW';
  if (score >= 75) asymmetrySignal = 'HIGH';
  else if (score >= 50) asymmetrySignal = 'MEDIUM';
  else if (score >= 25) asymmetrySignal = 'LOW';
  else asymmetrySignal = 'NOISE';

  let quickReasoning = '';
  if (asymmetrySignal === 'HIGH') {
    if (isCluster && isCFOorGC) {
      quickReasoning = `Ekstrem asymmetri: ${tx.insiderTitle} deltager i et koordineret cluster-køb efter kursfald og øger sin position med ${tx.holdingsIncreasePct}%.`;
    } else {
      quickReasoning = `Stærkt asymmetrisk signal: ${tx.insiderTitle} allokerer betydelige egne midler og øger beholdningen med ${tx.holdingsIncreasePct}%.`;
    }
  } else if (asymmetrySignal === 'MEDIUM') {
    quickReasoning = `Moderat signal: ${tx.insiderTitle} køber for $${Math.round(tx.totalValueUsd).toLocaleString()} (+${tx.holdingsIncreasePct}% beholdning), hvilket indikerer tiltro til værdiansættelsen.`;
  } else {
    quickReasoning = `Begrænset signal: Købet repræsenterer moderat overbevisning uden stærke cluster- eller rollerelaterede katalysatorer.`;
  }

  return {
    passedHardFilter: true,
    geminiPreScore: score,
    scoreSource: 'heuristik',
    asymmetrySignal,
    quickReasoning: `Heuristik (ingen Gemini-vurdering): ${quickReasoning}`,
  };
}

/**
 * Evaluerer en insider-transaktion via Gemini Gatekeeper / Parser.
 * Kører først 0-token Hard Filter. Falder tilbage til heuristik hvis API-nøgle mangler.
 */
export async function evaluateWithGatekeeper(tx: InsiderTransaction): Promise<GatekeeperResult> {
  // 1. Kør Hard Filter (koster 0 tokens)
  const hardFilter = applyHardFilter(tx);
  if (!hardFilter.passed) {
    return {
      passedHardFilter: false,
      hardFilterReason: hardFilter.reason,
      geminiPreScore: 0,
      scoreSource: 'heuristik',
      asymmetrySignal: 'NOISE',
      quickReasoning: hardFilter.reason || 'Afvist af det regelbaserede hard filter.',
    };
  }

  // 2. Tjek om Gemini API-nøgle er tilgængelig
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '' || apiKey.includes('your-')) {
    return evaluateHeuristicGatekeeper(tx);
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const model = await resolveGeminiFlashModel(ai);

    const systemInstruction = `Du er en koldblodig kvantitativ Gatekeeper & Insider Parser for investeringsfonden InsiderOps.
Din opgave er lynhurtigt at vurdere graden af sandsynlig informationsasymmetri på en skala fra 0-100 baseret på en SEC Form 4 insider-transaktion.

Regler for scoring:
1. CFO (Finansdirektør) og General Counsel (Chefjurist) kender virksomhedens likviditet, retssager og regnskabstal bedre end nogen andre: Vægt deres køb EKSTREMT højt (+20-30 point).
2. Stor forøgelse af beholdning (holdingsIncreasePct > 15%) viser reel "skin-in-the-game" overbevisning: Vægt højt.
3. Cluster-køb (isClusterBuy = true, flere insidere køber inden for 10 dage): Vægt meget højt.
4. Straffe "Cosmetic / PR buys" hårdt med en lav score (<35): Hvis en direktør (f.eks. CEO) køber for et pænt beløb over $50k, men det kun øger deres beholdning med < 2%, er det et PR-stunt designet til at narre detailinvestorer.
5. Rule 10b5-1 automatisk handelsplan (is10b51Plan = true): Hvis handlen er udført under en forudbestemt automatisk handelsplan eller nævner 10b5-1, har den 0% aktuel informationsasymmetri. Straffes NÅDESLØST med score < 20 og asymmetrySignal = 'NOISE'.
6. quickReasoning SKAL være 1-2 knivskarpe sætninger på præcist dansk.
${UNTRUSTED_DATA_INSTRUCTION}`;

    const prompt = `Evaluer følgende insider-transaktion for informationsasymmetri:
Ticker: ${tx.ticker} (${tx.companyName})
Insider: ${tx.insiderName}
Titel: ${tx.insiderTitle}
Transaktion: Kode ${tx.transactionCode} (${tx.shares.toLocaleString()} aktier a $${tx.pricePerShare})
Samlet værdi: $${Math.round(tx.totalValueUsd).toLocaleString()} USD
Holdings efter køb: ${tx.sharesOwnedFollowing !== undefined ? `${tx.sharesOwnedFollowing.toLocaleString()} aktier` : 'ikke oplyst'}
Forøgelse af egen beholdning: ${tx.holdingsIncreasePct !== undefined ? `+${tx.holdingsIncreasePct}%` : 'ukendt'}
Cluster-køb: ${tx.isClusterBuy ? `Ja (${tx.clusterCount ?? 2} insidere)` : 'Nej'}
Rule 10b5-1 Plan: ${tx.is10b51Plan === undefined ? 'UKENDT (ikke tjekket i Form 4)' : tx.is10b51Plan ? 'JA (Forudbestemt automatisk algoritme/plan)' : 'NEJ (Frivilligt, skønsmæssigt køb)'}
Kursændring seneste 30 dage: ${tx.recentPriceChange30dPct !== undefined ? `${tx.recentPriceChange30dPct}%` : 'Ukendt'}
Kontekst / Noter: ${tx.contextNotes ? untrusted('kontekst-noter', tx.contextNotes) : 'Ingen yderligere noter'}`;

    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            geminiPreScore: {
              type: Type.NUMBER,
              description: 'Vurdering af informationsasymmetri fra 0 til 100.',
            },
            asymmetrySignal: {
              type: Type.STRING,
              enum: ['HIGH', 'MEDIUM', 'LOW', 'NOISE'],
              description: 'Kategorisering af asymmetri-signalet.',
            },
            quickReasoning: {
              type: Type.STRING,
              description: '1-2 knivskarpe sætninger på dansk om vurderingen.',
            },
          },
          required: ['geminiPreScore', 'asymmetrySignal', 'quickReasoning'],
        },
      },
    });

    const outputText = response.text;
    if (!outputText) {
      return evaluateHeuristicGatekeeper(tx);
    }

    const parsed = JSON.parse(outputText) as {
      geminiPreScore: number;
      asymmetrySignal: GatekeeperResult['asymmetrySignal'];
      quickReasoning: string;
    };

    if (!Number.isFinite(parsed.geminiPreScore)) {
      return evaluateHeuristicGatekeeper(tx);
    }

    return {
      passedHardFilter: true,
      geminiPreScore: clampScore(parsed.geminiPreScore),
      scoreSource: 'gemini',
      asymmetrySignal: parsed.asymmetrySignal,
      quickReasoning: parsed.quickReasoning,
    };
  } catch (error) {
    console.warn('Gemini API kald fejlede, bruger heuristisk gatekeeper:', error);
    return evaluateHeuristicGatekeeper(tx);
  }
}

/**
 * Evaluerer en hel liste af transaktioner med Gemini Gatekeeper.
 * OPTIMERET TIL GEMINI FREE TIER:
 * 1. Hard Filter afviser støj lokalt (0 requests, 0 tokens).
 * 2. Alle godkendte handler samles i ÉT enkelt struktureret batch-kald til Gemini (kun 1 API-request pr. scan!).
 * 3. Automatisk fallback til heuristisk vurdering ved eventuel netværksfejl eller HTTP 429.
 */
export async function evaluateBatchWithGatekeeper(
  transactions: InsiderTransaction[]
): Promise<Array<{ transaction: InsiderTransaction; result: GatekeeperResult }>> {
  if (transactions.length === 0) return [];

  // 1. Filtrer først alle transaktioner med det lokale Hard Filter
  const initialResults = transactions.map((tx) => {
    const hardFilter = applyHardFilter(tx);
    return { tx, hardFilter };
  });

  const rejectedItems = initialResults.filter((item) => !item.hardFilter.passed);
  const candidatesToScore = initialResults.filter((item) => item.hardFilter.passed);

  const resultMap = new Map<string, GatekeeperResult>();

  // Gem afviste resultater med det samme (koster 0 kald)
  for (const { tx, hardFilter } of rejectedItems) {
    resultMap.set(tx.id, {
      passedHardFilter: false,
      hardFilterReason: hardFilter.reason,
      geminiPreScore: 0,
      scoreSource: 'heuristik',
      asymmetrySignal: 'NOISE',
      quickReasoning: hardFilter.reason || 'Afvist af det regelbaserede hard filter.',
    });
  }

  // Hvis ingen transaktioner bestod Hard Filter, returnér straks
  if (candidatesToScore.length === 0) {
    return transactions.map((tx) => ({
      transaction: tx,
      result: resultMap.get(tx.id)!,
    }));
  }

  const apiKey = process.env.GEMINI_API_KEY;

  // Hvis ingen API-nøgle er sat, brug heuristik for kandidaterne
  if (!apiKey || apiKey.trim() === '' || apiKey.includes('your-')) {
    for (const { tx } of candidatesToScore) {
      resultMap.set(tx.id, evaluateHeuristicGatekeeper(tx));
    }
    return transactions.map((tx) => ({
      transaction: tx,
      result: resultMap.get(tx.id)!,
    }));
  }

  // 2. Kør Gemini batch-kald i små chunks (afskårne svar logges som fejl og falder til heuristik)
  try {
    const ai = new GoogleGenAI({ apiKey });
    const model = await resolveGeminiFlashModel(ai);

    const chunks: Array<typeof candidatesToScore> = [];
    for (let i = 0; i < candidatesToScore.length; i += GATEKEEPER_CHUNK_SIZE) {
      chunks.push(candidatesToScore.slice(i, i + GATEKEEPER_CHUNK_SIZE));
    }

    // Sekventielt (ikke parallelt): Free Tier tillader 5 kald/min og 20 kald/dag. Er dagskvoten brugt,
    // springes resten over i stedet for at brænde flere kald af.
    let quotaExhausted = false;
    for (const chunk of chunks) {
        if (quotaExhausted) {
          console.error(`Gemini Gatekeeper sprunget over for ${chunk.map(({ tx }) => tx.ticker).join(', ')} – kvoten er opbrugt, heuristisk score bruges`);
          continue;
        }
        const batchPayload = chunk.map(({ tx }) => ({
          id: tx.id,
          ticker: tx.ticker,
          companyName: tx.companyName,
          insiderName: tx.insiderName,
          insiderTitle: tx.insiderTitle,
          shares: tx.shares,
          pricePerShare: tx.pricePerShare,
          totalValueUsd: Math.round(tx.totalValueUsd),
          holdingsIncreasePct: tx.holdingsIncreasePct ?? 'ukendt',
          is10b51Plan: tx.is10b51Plan === undefined ? 'ukendt' : tx.is10b51Plan ? 'ja' : 'nej',
          isClusterBuy: tx.isClusterBuy,
          clusterCount: tx.clusterCount ?? 1,
          recentPriceChange30dPct: tx.recentPriceChange30dPct,
          contextNotes: tx.contextNotes ? untrusted('kontekst-noter', tx.contextNotes) : '',
        }));

        try {
          const response = await withGeminiQuotaRetry(() => ai.models.generateContent({
            model,
            contents: `Du er InsiderOps Gatekeeper. Evaluer hver af følgende ${batchPayload.length} godkendte insider-transaktioner:
${JSON.stringify(batchPayload, null, 2)}`,
            config: {
              maxOutputTokens: GATEKEEPER_MAX_OUTPUT_TOKENS,
              thinkingConfig: lowThinkingConfig(model),
              systemInstruction: `Du er Gatekeeper for en kvantitativ investeringsfond. Vurder graden af sandsynlig informationsasymmetri på en skala fra 0-100 for hver transaktion.
Vægt CFO og General Counsel køb ekstremt højt (+20-30 point).
Vægt høj holdingsIncreasePct (>15%) og isClusterBuy højt (+15 point).
Straffe "Cosmetic/PR buys" (hvor en direktør køber for et beløb der øger beholdningen med <2%).
is10b51Plan = 'ja': købet er forudplanlagt under en Rule 10b5-1-plan og har ingen aktuel informationsasymmetri – giv score < 20 og asymmetrySignal 'NOISE'. 'ukendt': ingen straf, men ingen bonus for timing. holdingsIncreasePct = 'ukendt' må hverken belønnes eller straffes.
Kategoriser asymmetrySignal som 'HIGH' (score >= 75), 'MEDIUM' (50-74), 'LOW' (25-49), eller 'NOISE' (< 25).
Returner en præcis JSON-array med et element for hver transaktion med id, geminiPreScore, asymmetrySignal og 1-2 knivskarpe sætninger på dansk i quickReasoning.
${UNTRUSTED_DATA_INSTRUCTION}`,
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    geminiPreScore: { type: Type.INTEGER },
                    asymmetrySignal: {
                      type: Type.STRING,
                      enum: ['HIGH', 'MEDIUM', 'LOW', 'NOISE'],
                    },
                    quickReasoning: { type: Type.STRING },
                  },
                  required: ['id', 'geminiPreScore', 'asymmetrySignal', 'quickReasoning'],
                },
              },
            },
          }), () => {
            quotaExhausted = true;
          });

          const finishReason = response.candidates?.[0]?.finishReason;
          if (finishReason === FinishReason.MAX_TOKENS) {
            throw new Error(
              `Gemini-svaret blev afskåret (finishReason MAX_TOKENS, ${chunk.length} tickers, usage ${JSON.stringify(response.usageMetadata ?? {})})`
            );
          }
          const parsed = parseGatekeeperBatch(response.text);

          for (const item of parsed) {
            // Ikke-numerisk score → ingen Gemini-vurdering; udfyldes som heuristik nedenfor.
            if (item.id && Number.isFinite(item.geminiPreScore)) {
              resultMap.set(item.id, {
                passedHardFilter: true,
                geminiPreScore: clampScore(item.geminiPreScore),
                scoreSource: 'gemini',
                asymmetrySignal: item.asymmetrySignal,
                quickReasoning: item.quickReasoning,
              });
            }
          }
        } catch (chunkErr) {
          // Fejl, ikke advarsel: rækkerne får scoreSource 'heuristik' og kan ikke starte auto-køen.
          console.error(
            `Gemini Gatekeeper fejlede for ${chunk.map(({ tx }) => tx.ticker).join(', ')} – heuristisk score bruges:`,
            chunkErr instanceof Error ? chunkErr.message.slice(0, 300) : chunkErr
          );
        }
    }

    // Udfyld eventuelle manglende med heuristik som sikkerhedsnet
    for (const { tx } of candidatesToScore) {
      if (!resultMap.has(tx.id)) {
        resultMap.set(tx.id, evaluateHeuristicGatekeeper(tx));
      }
    }
  } catch (batchErr) {
    console.warn(
      'Gemini batch evaluering fejlede (f.eks. rate-limit eller timeout), falder tilbage til heuristik:',
      batchErr
    );
    for (const { tx } of candidatesToScore) {
      if (!resultMap.has(tx.id)) {
        resultMap.set(tx.id, evaluateHeuristicGatekeeper(tx));
      }
    }
  }

  return transactions.map((tx) => ({
    transaction: tx,
    result: resultMap.get(tx.id) || evaluateHeuristicGatekeeper(tx),
  }));
}
