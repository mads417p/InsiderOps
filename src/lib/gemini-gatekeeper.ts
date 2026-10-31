import { GoogleGenAI, Type } from '@google/genai';
import { applyHardFilter } from '@/lib/sec-scanner';
import { GatekeeperResult, InsiderTransaction } from '@/types/insider';

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
  const isCosmetic = tx.holdingsIncreasePct < 2.0;
  const isStrongIncrease = tx.holdingsIncreasePct >= 15.0;
  const isCluster = tx.isClusterBuy;
  const isLargeValue = tx.totalValueUsd >= 250000;
  const hadPriceDrop = (tx.recentPriceChange30dPct ?? 0) <= -15.0;

  // Håndter Rule 10b5-1 automatiske handelsplaner (0% aktuel asymmetri)
  if (tx.is10b51Plan) {
    return {
      passedHardFilter: true,
      geminiPreScore: 16,
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

  score = Math.min(Math.max(score, 10), 98);

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
    asymmetrySignal,
    quickReasoning,
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
6. quickReasoning SKAL være 1-2 knivskarpe sætninger på præcist dansk.`;

    const prompt = `Evaluer følgende insider-transaktion for informationsasymmetri:
Ticker: ${tx.ticker} (${tx.companyName})
Insider: ${tx.insiderName}
Titel: ${tx.insiderTitle}
Transaktion: Kode ${tx.transactionCode} (${tx.shares.toLocaleString()} aktier a $${tx.pricePerShare})
Samlet værdi: $${Math.round(tx.totalValueUsd).toLocaleString()} USD
Holdings efter køb: ${tx.sharesOwnedFollowing.toLocaleString()} aktier
Forøgelse af egen beholdning: +${tx.holdingsIncreasePct}%
Cluster-køb: ${tx.isClusterBuy ? `Ja (${tx.clusterCount ?? 2} insidere)` : 'Nej'}
Rule 10b5-1 Plan: ${tx.is10b51Plan ? 'JA (Forudbestemt automatisk algoritme/plan)' : 'NEJ (Frivilligt, skønsmæssigt køb)'}
Kursændring seneste 30 dage: ${tx.recentPriceChange30dPct !== undefined ? `${tx.recentPriceChange30dPct}%` : 'Ukendt'}
Kontekst / Noter: ${tx.contextNotes || 'Ingen yderligere noter'}`;

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

    return {
      passedHardFilter: true,
      geminiPreScore: Math.round(parsed.geminiPreScore),
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

  // 2. Kør Gemini batch-kald opdelt i chunks af max 12 transaktioner med 4096 output tokens
  try {
    const ai = new GoogleGenAI({ apiKey });
    const model = await resolveGeminiFlashModel(ai);

    const CHUNK_SIZE = 12;
    const chunks: Array<typeof candidatesToScore> = [];
    for (let i = 0; i < candidatesToScore.length; i += CHUNK_SIZE) {
      chunks.push(candidatesToScore.slice(i, i + CHUNK_SIZE));
    }

    await Promise.allSettled(
      chunks.map(async (chunk) => {
        const batchPayload = chunk.map(({ tx }) => ({
          id: tx.id,
          ticker: tx.ticker,
          companyName: tx.companyName,
          insiderName: tx.insiderName,
          insiderTitle: tx.insiderTitle,
          shares: tx.shares,
          pricePerShare: tx.pricePerShare,
          totalValueUsd: Math.round(tx.totalValueUsd),
          holdingsIncreasePct: tx.holdingsIncreasePct,
          isClusterBuy: tx.isClusterBuy,
          clusterCount: tx.clusterCount ?? 1,
          recentPriceChange30dPct: tx.recentPriceChange30dPct,
          contextNotes: tx.contextNotes || '',
        }));

        try {
          const response = await ai.models.generateContent({
            model,
            contents: `Du er InsiderOps Gatekeeper. Evaluer hver af følgende ${batchPayload.length} godkendte insider-transaktioner:
${JSON.stringify(batchPayload, null, 2)}`,
            config: {
              maxOutputTokens: 4096,
              systemInstruction: `Du er Gatekeeper for en kvantitativ investeringsfond. Vurder graden af sandsynlig informationsasymmetri på en skala fra 0-100 for hver transaktion.
Vægt CFO og General Counsel køb ekstremt højt (+20-30 point).
Vægt høj holdingsIncreasePct (>15%) og isClusterBuy højt (+15 point).
Straffe "Cosmetic/PR buys" (hvor en direktør køber for et beløb der øger beholdningen med <2%).
Kategoriser asymmetrySignal som 'HIGH' (score >= 75), 'MEDIUM' (50-74), 'LOW' (25-49), eller 'NOISE' (< 25).
Returner en præcis JSON-array med et element for hver transaktion med id, geminiPreScore, asymmetrySignal og 1-2 knivskarpe sætninger på dansk i quickReasoning.`,
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
          });

          const parsed = JSON.parse(response.text || '[]') as Array<{
            id: string;
            geminiPreScore: number;
            asymmetrySignal: GatekeeperResult['asymmetrySignal'];
            quickReasoning: string;
          }>;

          for (const item of parsed) {
            if (item.id) {
              resultMap.set(item.id, {
                passedHardFilter: true,
                geminiPreScore: Math.round(item.geminiPreScore),
                asymmetrySignal: item.asymmetrySignal,
                quickReasoning: item.quickReasoning,
              });
            }
          }
        } catch (chunkErr) {
          console.warn('Chunk evaluering i Gemini Gatekeeper fejlede, falder tilbage til heuristik for denne chunk:', chunkErr);
        }
      })
    );

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
