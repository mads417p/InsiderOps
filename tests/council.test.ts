import { describe, expect, it } from 'vitest';
import { CouncilError, parseJudgeMessage } from '@/lib/claude-council';

const msg = (body: unknown, stop_reason: string | null = 'end_turn') => ({
  stop_reason,
  content: [
    { type: 'thinking' },
    { type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) },
  ],
});

const valid = {
  asymmetryScore: 82,
  verdict: 'STRONG ASYMMETRY (KØB)',
  headline: 'CFO køber efter kursfald',
  synthesis: 'Profiler og Catalyst vejer tungere end Skeptic.',
};

const reasonOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof CouncilError ? err.reason : `anden fejl: ${String(err)}`;
  }
  return 'ingen fejl';
};

describe('dommer-validering (parseJudgeMessage)', () => {
  it('accepterer et gyldigt svar', () => {
    expect(parseJudgeMessage(msg(valid))).toEqual(valid);
  });

  it('afviser score uden for 0–100 og ikke-heltal', () => {
    for (const asymmetryScore of [101, -1, 50.5, '80', null]) {
      expect(reasonOf(() => parseJudgeMessage(msg({ ...valid, asymmetryScore })))).toBe('INVALID_JUDGE_OUTPUT');
    }
    expect(parseJudgeMessage(msg({ ...valid, asymmetryScore: 0 })).asymmetryScore).toBe(0);
    expect(parseJudgeMessage(msg({ ...valid, asymmetryScore: 100 })).asymmetryScore).toBe(100);
  });

  it('afviser forkert enum og accepterer case-insensitiv enum som kanonisk værdi', () => {
    expect(reasonOf(() => parseJudgeMessage(msg({ ...valid, verdict: 'KØB' })))).toBe('INVALID_JUDGE_OUTPUT');
    expect(parseJudgeMessage(msg({ ...valid, verdict: ' strong asymmetry (køb) ' })).verdict).toBe(
      'STRONG ASYMMETRY (KØB)'
    );
  });

  it('afviser tom headline eller synthesis', () => {
    expect(reasonOf(() => parseJudgeMessage(msg({ ...valid, headline: '  ' })))).toBe('INVALID_JUDGE_OUTPUT');
    expect(reasonOf(() => parseJudgeMessage(msg({ ...valid, synthesis: undefined })))).toBe('INVALID_JUDGE_OUTPUT');
  });

  it('afviser et afskåret svar (max_tokens), også selvom teksten er gyldig JSON', () => {
    expect(reasonOf(() => parseJudgeMessage(msg('{"asymmetryScore": 8', 'max_tokens')))).toBe('MAX_TOKENS');
    expect(reasonOf(() => parseJudgeMessage(msg(valid, 'max_tokens')))).toBe('MAX_TOKENS');
  });

  it('afviser refusal og ugyldig JSON', () => {
    expect(reasonOf(() => parseJudgeMessage(msg(valid, 'refusal')))).toBe('REFUSAL');
    expect(reasonOf(() => parseJudgeMessage(msg('Her er min dom: KØB')))).toBe('INVALID_JUDGE_OUTPUT');
  });
});
