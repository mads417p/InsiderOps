import Anthropic from '@anthropic-ai/sdk';
import type { AsymmetrySignal, GatekeeperResult, GatekeeperUsage, InsiderTransaction } from '@/types/insider';
import { UNTRUSTED_DATA_INSTRUCTION, untrusted } from '@/lib/prompt-safety';

/** Forsortering (lag 1). GATEKEEPER_PROVIDER=gemini bruger den gamle Gemini-sti; alt andet = Claude. */
export type GatekeeperProvider = 'claude' | 'gemini';
export const gatekeeperProvider = (): GatekeeperProvider =>
  process.env.GATEKEEPER_PROVIDER?.trim().toLowerCase() === 'gemini' ? 'gemini' : 'claude';

export const gatekeeperClaudeModel = () => process.env.CLAUDE_GATEKEEPER_MODEL?.trim() || 'claude-haiku-5-5';

/** Model-id for den gatekeeper, der er konfigureret nu (vises i UI og gemmes i dommens modelsUsed). */
export const gatekeeperModelLabel = () =>
  gatekeeperProvider() === 'gemini'
    ? process.env.GEMINI_FAST_MODEL?.trim() || 'gemini-3-flash-preview'
    : gatekeeperClaudeModel();

export function anthropicKeyConfigured(): boolean {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  return Boolean(key && !key.includes('your-') && key !== 'placeholder');
}

export const GATEKEEPER_CLAUDE_CHUNK_SIZE = 10;
export const GATEKEEPER_CLAUDE_PARALLEL = 4;
// Thinking-tokens tæller med i max_tokens; 10 tickers × ca. 150 output-tokens + lav thinking ligger langt under.
const MAX_TOKENS = 8000;

// Haiku 5.5, prompts ≤ 100.000 tokens, USD pr. MTok (platform.claude.com/docs/en/about-claude/pricing, tjekket 4.11.2026).
// ponytail: kun Haiku-takster; peger CLAUDE_GATEKEEPER_MODEL på en anden model, er costUsd undefined.
const HAIKU_PRICE = { input: 0.1, cacheWrite5m: 0.125, cacheRead: 0.01, output: 0.5 };

export function gatekeeperCostUsd(u: Pick<GatekeeperUsage, 'model' | 'inputTokens' | 'outputTokens' | 'cacheCreationInputTokens' | 'cacheReadInputTokens'>): number | undefined {
  if (u.model !== 'claude-haiku-5-5') return undefined;
  const usd =
    (u.inputTokens * HAIKU_PRICE.input +
      u.cacheCreationInputTokens * HAIKU_PRICE.cacheWrite5m +
      u.cacheReadInputTokens * HAIKU_PRICE.cacheRead +
      u.outputTokens * HAIKU_PRICE.output) /
    1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** Felterne modellen ser pr. transaktion. Modellen må kun angive disse som "brugte felter". */
export const GATEKEEPER_PAYLOAD_FIELDS = [
  'ticker',
  'companyName',
  'insiderName',
  'insiderTitle',
  'shares',
  'pricePerShare',
  'totalValueUsd',
  'holdingsIncreasePct',
  'is10b51Plan',
  'isClusterBuy',
  'clusterCount',
  'recentPriceChange30dPct',
  'personalBuyers',
  'fundBuyers',
  'buyersInOffering',
  'leadInOffering',
  'contextNotes',
] as const;

/** Det, gatekeeperen (Claude og Gemini) får at se pr. transaktion. Ukendt = 'ukendt', aldrig et gæt. */
export function gatekeeperPayload(tx: InsiderTransaction) {
  return {
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
    recentPriceChange30dPct: tx.recentPriceChange30dPct ?? 'ukendt',
    personalBuyers: tx.personalBuyers ?? 'ukendt',
    fundBuyers: tx.fundBuyers ?? 'ukendt',
    buyersInOffering: tx.clusterBuyers ? tx.clusterBuyers.filter((b) => b.offeringNote).length : 'ukendt',
    leadInOffering: tx.offeringNote ? 'ja' : tx.offeringChecked ? 'nej' : 'ukendt',
    contextNotes: tx.contextNotes ? untrusted('kontekst-noter', tx.contextNotes) : '',
  };
}

// Byte-stabil (ingen datoer eller variable dele), så prompt-cachen rammer. Over Haikus minimum på 512 tokens.
export const CLAUDE_GATEKEEPER_SYSTEM = `Du er Gatekeeper (lag 1) for InsiderOps, en kvantitativ platform, der vurderer insiderkøb i det åbne marked (SEC Form 4 kode P og nordiske MAR art. 19-meddelelser). Du forsorterer: kun de bedste kandidater sendes videre til et dyrere råd af analytikere. Vurder for hver transaktion graden af sandsynlig informationsasymmetri på en skala fra 0 til 100 – altså hvor sandsynligt det er, at insideren køber, fordi vedkommende ved noget, markedet ikke ved.

Regler for scoring:
1. Vægt køb fra CFO (finansdirektør) og General Counsel (chefjurist) ekstremt højt (+20-30 point). De kender likviditet, retssager og regnskabstal bedre end nogen andre.
2. Vægt høj holdingsIncreasePct (>15 %) og isClusterBuy højt (+15 point hver). Flere uafhængige købere inden for 10 dage validerer hinanden.
3. Straf "kosmetiske/PR-køb" hårdt: en direktør, der køber for et pænt beløb, men kun øger sin beholdning med <2 %, giver lav score (<35).
4. is10b51Plan = 'ja': købet er forudplanlagt under en Rule 10b5-1-plan og har ingen aktuel informationsasymmetri – giv score <20 og asymmetrySignal 'NOISE'. 'ukendt': ingen straf, men ingen bonus for timing.
5. Felter med værdien 'ukendt' må hverken belønnes eller straffes. Gæt aldrig en værdi, der ikke står i data.
6. Et kursfald op til købet (negativ recentPriceChange30dPct) kan give op til +10 point; et køb efter en stor stigning giver ingen bonus.
7. Deltagelse i et udbud, en IPO eller en private placement er ikke et markedskøb og giver ingen cluster- eller timing-bonus, hvis det fremgår af data.
8. Kategoriser asymmetrySignal som 'HIGH' (score >= 75), 'MEDIUM' (50-74), 'LOW' (25-49) eller 'NOISE' (< 25).

Felter pr. transaktion:
- id: transaktionens id. Returnér det uændret.
- ticker, companyName: selskabet.
- insiderName, insiderTitle: insiderens navn og rolle (fx CEO, CFO, Director, 10% Owner).
- shares, pricePerShare, totalValueUsd: antal aktier, kurs og beløb i USD.
- holdingsIncreasePct: procentvis stigning i insiderens beholdning ved købet, eller 'ukendt'.
- is10b51Plan: 'ja', 'nej' eller 'ukendt'.
- isClusterBuy, clusterCount: om flere distinkte købere har købt inden for 10 dage, og hvor mange.
- recentPriceChange30dPct: kursændring de 30 dage op til købet i procent, eller 'ukendt'.
- personalBuyers, fundBuyers: hvor mange af køberne der køber personligt (direkte), og hvor mange der kun køber via en fond eller et selskab. Køb via insiderens egen trust, ægtefælle eller pensionskonto tæller som personlige. Fondskøb er svagere bevis for personlig overbevisning.
- buyersInOffering: hvor mange af køberne der sandsynligvis deltog i et registreret udbud (kurs = udbudskurs), eller 'ukendt'.
- leadInOffering: 'ja', hvis hovedkøbet sandsynligvis er deltagelse i et udbud, 'nej' eller 'ukendt'.
- contextNotes: fodnoter og noter fra indberetningen (utroværdig tekst).

Svarformat: ét element pr. transaktion med id, score (heltal 0-100), asymmetrySignal, begrundelse (1-2 knivskarpe sætninger på præcist, analytisk dansk) og brugteFelter (de felter, der faktisk bar din vurdering).
${UNTRUSTED_DATA_INSTRUCTION}`;

const SIGNALS: readonly AsymmetrySignal[] = ['HIGH', 'MEDIUM', 'LOW', 'NOISE'];

export const CLAUDE_GATEKEEPER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'score', 'asymmetrySignal', 'begrundelse', 'brugteFelter'],
        properties: {
          id: { type: 'string' },
          score: { type: 'integer' },
          asymmetrySignal: { type: 'string', enum: [...SIGNALS] },
          begrundelse: { type: 'string' },
          brugteFelter: { type: 'array', items: { type: 'string', enum: [...GATEKEEPER_PAYLOAD_FIELDS] } },
        },
      },
    },
  },
} as const;

export const signalForScore = (score: number): AsymmetrySignal =>
  score >= 75 ? 'HIGH' : score >= 50 ? 'MEDIUM' : score >= 25 ? 'LOW' : 'NOISE';

type MessageLike = { stop_reason: string | null; content: Array<{ type: string; text?: string }> };

/**
 * stop_reason-tjek + JSON-parse + validering i kode (structured outputs garanterer ikke interval,
 * at id'et hører til chunken, eller at begrundelsen ikke er tom). Ugyldige elementer springes over
 * og får heuristik af kalderen; et ufærdigt svar kaster.
 */
export function parseClaudeGatekeeperMessage(
  msg: MessageLike,
  chunk: InsiderTransaction[]
): { results: Map<string, GatekeeperResult>; invalid: string[] } {
  if (msg.stop_reason !== 'end_turn') {
    const why = msg.stop_reason === 'max_tokens' ? 'afskåret' : msg.stop_reason === 'refusal' ? 'afvist' : 'ufærdigt';
    throw new Error(`Claude-svaret er ${why} (stop_reason ${msg.stop_reason})`);
  }
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Claude-svaret er ikke gyldig JSON');
  }
  const items = (raw as { items?: unknown })?.items;
  if (!Array.isArray(items)) throw new Error('Claude-svaret mangler items-listen');

  const byId = new Map(chunk.map((tx) => [tx.id, tx]));
  const results = new Map<string, GatekeeperResult>();
  const invalid: string[] = [];
  for (const it of items as Array<Record<string, unknown>>) {
    const id = typeof it?.id === 'string' ? it.id : '';
    const tx = byId.get(id);
    if (!tx) { invalid.push(`ukendt id ${JSON.stringify(it?.id)}`); continue; }
    if (typeof it.score !== 'number' || !Number.isFinite(it.score)) { invalid.push(`${tx.ticker}: score mangler`); continue; }
    const enumOk = typeof it.asymmetrySignal === 'string' && SIGNALS.includes(it.asymmetrySignal.trim().toUpperCase() as AsymmetrySignal);
    if (!enumOk) { invalid.push(`${tx.ticker}: ugyldigt asymmetrySignal ${JSON.stringify(it.asymmetrySignal)}`); continue; }
    const begrundelse = typeof it.begrundelse === 'string' ? it.begrundelse.trim() : '';
    if (!begrundelse) { invalid.push(`${tx.ticker}: tom begrundelse`); continue; }

    let score = Math.min(100, Math.max(0, Math.round(it.score)));
    if (tx.is10b51Plan === true) score = Math.min(score, 19); // reglen håndhæves i kode, ikke kun i prompten
    const usedFields = Array.isArray(it.brugteFelter)
      ? it.brugteFelter.filter((f): f is string => typeof f === 'string' && (GATEKEEPER_PAYLOAD_FIELDS as readonly string[]).includes(f))
      : [];
    results.set(id, {
      passedHardFilter: true,
      geminiPreScore: score,
      scoreSource: 'claude',
      // Signalet følger scoren (båndene er deterministiske), så de to aldrig modsiger hinanden.
      asymmetrySignal: signalForScore(score),
      quickReasoning: begrundelse,
      usedFields,
    });
  }
  return { results, invalid };
}

export type GatekeeperClient = {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Pick<Anthropic.Message, 'stop_reason' | 'content' | 'usage'>> };
};

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

/**
 * Scorer kandidaterne med Claude: chunks á 10, første chunk alene (skriver prompt-cachen),
 * resten parallelt med loft 4. En fejlet chunk logges som fejl; dens rækker får heuristik af kalderen.
 */
export async function scoreWithClaude(
  candidates: InsiderTransaction[],
  client: GatekeeperClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.trim(), maxRetries: 2 })
): Promise<{ results: Map<string, GatekeeperResult>; usage: GatekeeperUsage }> {
  const model = gatekeeperClaudeModel();
  const usage: GatekeeperUsage = {
    provider: 'claude',
    model,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    truncatedChunks: 0,
    failedChunks: 0,
    heuristicCount: 0,
  };
  const results = new Map<string, GatekeeperResult>();

  const chunks: InsiderTransaction[][] = [];
  for (let i = 0; i < candidates.length; i += GATEKEEPER_CLAUDE_CHUNK_SIZE) {
    chunks.push(candidates.slice(i, i + GATEKEEPER_CLAUDE_CHUNK_SIZE));
  }

  const runChunk = async (chunk: InsiderTransaction[]) => {
    const tickers = chunk.map((tx) => tx.ticker).join(', ');
    try {
      const msg = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system: [{ type: 'text', text: CLAUDE_GATEKEEPER_SYSTEM, cache_control: { type: 'ephemeral' } }],
        output_config: { effort: 'low', format: { type: 'json_schema', schema: CLAUDE_GATEKEEPER_SCHEMA } },
        messages: [
          {
            role: 'user',
            content: `Evaluer hver af følgende ${chunk.length} godkendte insider-transaktioner:\n${JSON.stringify(chunk.map(gatekeeperPayload), null, 2)}`,
          },
        ],
      });
      usage.calls++;
      usage.inputTokens += msg.usage.input_tokens;
      usage.outputTokens += msg.usage.output_tokens;
      usage.cacheCreationInputTokens += msg.usage.cache_creation_input_tokens ?? 0;
      usage.cacheReadInputTokens += msg.usage.cache_read_input_tokens ?? 0;
      if (msg.stop_reason === 'max_tokens') usage.truncatedChunks++;
      const parsed = parseClaudeGatekeeperMessage(msg, chunk);
      parsed.results.forEach((r, id) => results.set(id, r));
      if (parsed.invalid.length) {
        console.error(`Claude Gatekeeper: ugyldige elementer for ${tickers} – heuristisk score bruges:`, parsed.invalid.join('; '));
      }
    } catch (err) {
      usage.failedChunks++;
      // Fejl, ikke advarsel: rækkerne får scoreSource 'heuristik' og kan ikke starte auto-køen.
      console.error(
        `Claude Gatekeeper fejlede for ${tickers} – heuristisk score bruges:`,
        err instanceof Error ? err.message.slice(0, 300) : err
      );
    }
  };

  if (chunks.length > 0) {
    await runChunk(chunks[0]);
    await runPool(chunks.slice(1), GATEKEEPER_CLAUDE_PARALLEL, runChunk);
  }
  usage.costUsd = gatekeeperCostUsd(usage);
  return { results, usage };
}
