import { FinishReason, GoogleGenAI, ThinkingLevel, Type, type ThinkingConfig } from '@google/genai';
import { applyHardFilter } from '@/lib/sec-scanner';
import { GatekeeperResult, GatekeeperUsage, InsiderTransaction } from '@/types/insider';
import { UNTRUSTED_DATA_INSTRUCTION } from '@/lib/prompt-safety';
import {
  anthropicKeyConfigured,
  gatekeeperModelLabel,
  gatekeeperPayload,
  gatekeeperProvider,
  scoreWithClaude,
  type GatekeeperClient,
} from '@/lib/claude-gatekeeper';

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
 * Deterministisk heuristisk score, når gatekeeper-modellen ikke svarer (manglende nøgle, kvote, fejl).
 * Mærkes 'heuristik' og kan aldrig starte auto-køen.
 */
export function evaluateHeuristicGatekeeper(tx: InsiderTransaction): GatekeeperResult {
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
    quickReasoning: `Heuristik (ingen model-vurdering): ${quickReasoning}`,
  };
}

const emptyUsage = (provider: GatekeeperUsage['provider'], model?: string): GatekeeperUsage => ({
  provider,
  model,
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  truncatedChunks: 0,
  failedChunks: 0,
  heuristicCount: 0,
});

/**
 * Gemini-stien (GATEKEEPER_PROVIDER=gemini). Chunks køres sekventielt pga. Free Tier (5 kald/min, 20/dag);
 * er dagskvoten brugt, springes resten over. Afskårne svar logges som fejl; rækkerne får heuristik af kalderen.
 */
async function scoreWithGemini(candidates: InsiderTransaction[], resultMap: Map<string, GatekeeperResult>): Promise<GatekeeperUsage> {
  const apiKey = process.env.GEMINI_API_KEY;
  const usage = emptyUsage('gemini');
  if (!apiKey || apiKey.trim() === '' || apiKey.includes('your-')) {
    console.error('GEMINI_API_KEY mangler – Gemini Gatekeeper kan ikke køre, heuristisk score bruges');
    return usage;
  }
  const ai = new GoogleGenAI({ apiKey });
  const model = await resolveGeminiFlashModel(ai);
  usage.model = model;

  let quotaExhausted = false;
  for (let i = 0; i < candidates.length; i += GATEKEEPER_CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + GATEKEEPER_CHUNK_SIZE);
    const tickers = chunk.map((tx) => tx.ticker).join(', ');
    if (quotaExhausted) {
      console.error(`Gemini Gatekeeper sprunget over for ${tickers} – kvoten er opbrugt, heuristisk score bruges`);
      usage.failedChunks++;
      continue;
    }
    const batchPayload = chunk.map(gatekeeperPayload);
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
                asymmetrySignal: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'NOISE'] },
                quickReasoning: { type: Type.STRING },
              },
              required: ['id', 'geminiPreScore', 'asymmetrySignal', 'quickReasoning'],
            },
          },
        },
      }), () => {
        quotaExhausted = true;
      });
      usage.calls++;
      usage.inputTokens += response.usageMetadata?.promptTokenCount ?? 0;
      usage.outputTokens += (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0);
      usage.cacheReadInputTokens += response.usageMetadata?.cachedContentTokenCount ?? 0;

      if (response.candidates?.[0]?.finishReason === FinishReason.MAX_TOKENS) {
        usage.truncatedChunks++;
        throw new Error(
          `Gemini-svaret blev afskåret (finishReason MAX_TOKENS, ${chunk.length} tickers, usage ${JSON.stringify(response.usageMetadata ?? {})})`
        );
      }
      for (const item of parseGatekeeperBatch(response.text)) {
        // Ikke-numerisk score → ingen Gemini-vurdering; udfyldes som heuristik af kalderen.
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
      usage.failedChunks++;
      // Fejl, ikke advarsel: rækkerne får scoreSource 'heuristik' og kan ikke starte auto-køen.
      console.error(
        `Gemini Gatekeeper fejlede for ${tickers} – heuristisk score bruges:`,
        chunkErr instanceof Error ? chunkErr.message.slice(0, 300) : chunkErr
      );
    }
  }
  return usage;
}

/**
 * Lag 1: hard filter lokalt (0 tokens), derefter forsortering med Claude (default) eller Gemini
 * (GATEKEEPER_PROVIDER=gemini). Alt, modellen ikke scorer gyldigt, får heuristik med tydeligt mærke.
 */
export async function evaluateBatchWithGatekeeper(
  transactions: InsiderTransaction[],
  deps: { claudeClient?: GatekeeperClient } = {}
): Promise<{ evaluations: Array<{ transaction: InsiderTransaction; result: GatekeeperResult }>; usage: GatekeeperUsage }> {
  const provider = gatekeeperProvider();
  const resultMap = new Map<string, GatekeeperResult>();
  const candidates: InsiderTransaction[] = [];
  for (const tx of transactions) {
    const hardFilter = applyHardFilter(tx);
    if (hardFilter.passed) candidates.push(tx);
    else
      resultMap.set(tx.id, {
        passedHardFilter: false,
        hardFilterReason: hardFilter.reason,
        geminiPreScore: 0,
        scoreSource: 'heuristik',
        asymmetrySignal: 'NOISE',
        quickReasoning: hardFilter.reason || 'Afvist af det regelbaserede hard filter.',
      });
  }

  let usage = emptyUsage(provider, gatekeeperModelLabel());
  if (candidates.length > 0) {
    if (provider === 'gemini') {
      usage = await scoreWithGemini(candidates, resultMap);
    } else if (!anthropicKeyConfigured()) {
      console.error('ANTHROPIC_API_KEY mangler – Claude Gatekeeper kan ikke køre, heuristisk score bruges for alle kandidater');
    } else {
      const scored = await scoreWithClaude(candidates, deps.claudeClient);
      scored.results.forEach((r, id) => resultMap.set(id, r));
      usage = scored.usage;
    }
  }

  for (const tx of candidates) {
    if (!resultMap.has(tx.id)) {
      resultMap.set(tx.id, evaluateHeuristicGatekeeper(tx));
      usage.heuristicCount++;
    }
  }
  if (candidates.length > 0 && usage.heuristicCount === candidates.length) usage.provider = 'heuristik';

  return {
    evaluations: transactions.map((tx) => ({ transaction: tx, result: resultMap.get(tx.id)! })),
    usage,
  };
}
