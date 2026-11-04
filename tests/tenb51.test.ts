import { describe, expect, it } from 'vitest';
import { detect10b51, isPlanFootnote } from '@/lib/sec-scanner';

const line = (code: string, ref?: string) =>
  `<nonDerivativeTransaction><transactionCoding><transactionCode>${code}</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>100</value>${
    ref ? `<footnoteId id="${ref}"/>` : ''
  }</transactionShares></transactionAmounts></nonDerivativeTransaction>`;
const doc = (lines: string, notes: Record<string, string>, aff = '') =>
  `<ownershipDocument>${aff}<nonDerivativeTable>${lines}</nonDerivativeTable><footnotes>${Object.entries(notes)
    .map(([id, t]) => `<footnote id="${id}">${t}</footnote>`)
    .join('')}</footnotes></ownershipDocument>`;

const PLAN = 'The purchases reported were effected pursuant to a Rule 10b5-1 trading plan adopted on March 15, 2026.';

describe('10b5-1-detektor (audit P2)', () => {
  it('afkrydsningsfeltet <aff10b5One> giver true', () => {
    expect(detect10b51(doc(line('P'), {}, '<aff10b5One>1</aff10b5One>'))).toBe(true);
    expect(detect10b51(doc(line('P'), {}, '<aff10b5One>0</aff10b5One>'))).toBe(false);
  });

  it('fodnote refereret fra købslinjen giver true', () => {
    expect(detect10b51(doc(line('P', 'F1'), { F1: PLAN }))).toBe(true);
  });

  it('fodnote, som ingen købslinje refererer (fx kun salget), giver false', () => {
    expect(detect10b51(doc(line('P') + line('S', 'F2'), { F2: PLAN }))).toBe(false);
  });

  it('"not pursuant to" giver false', () => {
    const neg = 'These purchases were not made pursuant to a Rule 10b5-1 trading plan.';
    expect(isPlanFootnote(neg)).toBe(false);
    expect(detect10b51(doc(line('P', 'F1'), { F1: neg }))).toBe(false);
    expect(isPlanFootnote('Not effected under a 10b5-1 plan')).toBe(false);
    expect(isPlanFootnote(PLAN)).toBe(true);
  });
});
