import type { GatekeeperResult, InsiderTransaction } from '@/types/insider';
import { signalIdFor } from '@/lib/ledger';

/**
 * Auto-kø til rådet (fase 3): absolutte gatekeeper-scorer kan ikke sammenlignes på tværs af modeller
 * (Haiku giver højst ca. 68, så den gamle grænse 75 rammes aldrig). Derfor en rangregel pr. scan:
 * de N højest scorede rækker (kun Claude-scorer, score ≥ min). Af dem sendes kun signaler uden gemt dom.
 * Rang beregnes FØR dommede rækker fjernes, så gentagne scans ikke langsomt skubber køen ned ad listen.
 */
export interface AutoQueueRule {
  topN: number;
  minScore: number;
}

const intEnv = (name: string, fallback: number, min: number, max: number) => {
  const n = Number.parseInt(process.env[name]?.trim() ?? '', 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

export const autoQueueRule = (): AutoQueueRule => ({
  topN: intEnv('AUTO_QUEUE_TOP_N', 3, 0, 50),
  minScore: intEnv('AUTO_QUEUE_MIN_SCORE', 50, 0, 100),
});

export const autoQueueLabel = (r: AutoQueueRule) => `auto:rang-top${r.topN}-min${r.minScore}`;

/** Række-id'er, der skal til rådet. judgedSignalIds = signal-id'er (signalIdFor) med gemt dom. */
export function selectAutoQueue(
  items: Array<{ transaction: InsiderTransaction; result: GatekeeperResult }>,
  judgedSignalIds: Set<string>,
  rule: AutoQueueRule
): string[] {
  return items
    .filter(
      (i) =>
        i.result.passedHardFilter &&
        i.transaction.isTradableInDK !== false &&
        i.result.scoreSource === 'claude' &&
        i.result.geminiPreScore >= rule.minScore
    )
    .sort((a, b) => b.result.geminiPreScore - a.result.geminiPreScore)
    .slice(0, rule.topN)
    .filter((i) => !judgedSignalIds.has(signalIdFor(i.transaction)))
    .map((i) => i.transaction.id);
}
