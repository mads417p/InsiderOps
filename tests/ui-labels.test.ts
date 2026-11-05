import { describe, expect, it } from 'vitest';
import { isCeoCfoBuy, scoreLabel, verdictLabel } from '@/lib/ui-labels';

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

describe('isCeoCfoBuy', () => {
  const t = (insiderTitle: string, clusterTitles: string[] = []) => ({
    insiderTitle,
    clusterBuyers: clusterTitles.map((title) => ({ name: 'x', title, valueUsd: 1 })),
  });

  it('fanger CEO/CFO på engelsk og nordisk', () => {
    for (const title of ['CEO', 'President & CEO', 'Co-CEO', 'Chief Financial Officer', 'EVP, CFO', 'VD', 'Ekonomichef', 'Finansdirektør', 'Adm. direktør', 'Konsernsjef']) {
      expect(isCeoCfoBuy(t(title)), title).toBe(true);
    }
  });

  it('afviser andre roller og ord, der blot indeholder bogstaverne', () => {
    for (const title of ['Director', '10% Owner', 'COO', 'General Counsel', 'Styrelseledamot', 'Advisor', '']) {
      expect(isCeoCfoBuy(t(title)), title).toBe(false);
    }
  });

  it('tæller en CEO/CFO blandt cluster-køberne', () => {
    expect(isCeoCfoBuy(t('Director', ['Director', 'CFO']))).toBe(true);
  });
});
