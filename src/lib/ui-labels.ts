import type { GatekeeperResult } from '@/types/insider';

/**
 * Kun en model-score (Claude eller Gemini) må starte auto-køen. Allow-list: ældre gemte scans uden
 * scoreSource og heuristiske scorer giver false.
 */
export const isModelScore = (r: Pick<GatekeeperResult, 'scoreSource'>): boolean =>
  r.scoreSource === 'claude' || r.scoreSource === 'gemini';
