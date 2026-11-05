import { describe, expect, it } from 'vitest';
import { scoreLabel, verdictLabel } from '@/lib/ui-labels';

describe('verdictLabel / scoreLabel (kun visning)', () => {
  it('oversætter rådets tre domme og lader ukendte stå', () => {
    expect(verdictLabel('STRONG ASYMMETRY (KØB)')).toBe('Stærkt signal');
    expect(verdictLabel('MODERATE SIGNAL (OVERVÅG)')).toBe('Overvåg');
    expect(verdictLabel('PR STUNT / STØJ (IGNORER)')).toBe('Støj');
    expect(verdictLabel('noget andet')).toBe('noget andet');
  });

  it('bruger de gamle scoregrænser 75/60', () => {
    expect(scoreLabel(75)).toBe('Stærkt signal');
    expect(scoreLabel(74)).toBe('Overvåg');
    expect(scoreLabel(60)).toBe('Overvåg');
    expect(scoreLabel(59)).toBe('Støj');
  });
});
