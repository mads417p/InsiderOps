import { describe, expect, it } from 'vitest';
import {
  extractWithRegex,
  isValidIsin,
  numberAppearsInText,
  parseLocaleNumber,
  validateNordicExtraction,
  type NordicExtraction,
} from '@/lib/nordic-scanner';
import { enrichTransactionWithMarketData, MARKET_NOTES_MARKER } from '@/lib/market-enricher';

describe('locale-bevidst talparser (audit 1.7)', () => {
  it('dansk/svensk/finsk og engelsk notation', () => {
    expect(parseLocaleNumber('15 000', 'da')).toBe(15000); // før: 15
    expect(parseLocaleNumber('15 000', 'sv')).toBe(15000);
    expect(parseLocaleNumber('385,50', 'da')).toBe(385.5);
    expect(parseLocaleNumber('385.50', 'da')).toBe(385.5); // før: 38550
    expect(parseLocaleNumber('1.234,56', 'da')).toBe(1234.56);
    expect(parseLocaleNumber('1,234.56', 'en')).toBe(1234.56);
    expect(parseLocaleNumber('1.234.567')).toBe(1234567);
    expect(parseLocaleNumber('1.234', 'da')).toBe(1234);
    expect(parseLocaleNumber('1.234', 'en')).toBe(1.234);
    expect(parseLocaleNumber('1,234', 'en')).toBe(1234);
    expect(parseLocaleNumber('1,234', 'fi')).toBe(1.234);
  });

  it('tvetydige eller ugyldige tal giver null (afvis hellere end gæt)', () => {
    expect(parseLocaleNumber('1.234')).toBeNull();
    expect(parseLocaleNumber('1,234')).toBeNull();
    expect(parseLocaleNumber('12 34')).toBeNull();
    expect(parseLocaleNumber('abc')).toBeNull();
    expect(parseLocaleNumber('1.23.4')).toBeNull();
  });

  it('numberAppearsInText finder tal i begge notationer', () => {
    const text = 'Volume: 15 000 Price: DKK 385,50 Aggregated: 5.782.500,00';
    expect(numberAppearsInText(15000, text)).toBe(true);
    expect(numberAppearsInText(385.5, text)).toBe(true);
    expect(numberAppearsInText(5782500, text)).toBe(true);
    expect(numberAppearsInText(20000, text)).toBe(false);
  });
});

describe('validering af nordisk udtræk (audit 1.7)', () => {
  const text =
    'Name: Rasmus Errboe. Position: CEO. ISIN DK0062498333. Nature of the transaction: Purchase. Price DKK 385,50 Volume 15 000. Date of the transaction: 2026-11-03.';
  const ok: NordicExtraction = {
    id: '1',
    insiderName: 'Rasmus Errboe',
    insiderTitle: 'CEO',
    transactionType: 'MARKET_PURCHASE',
    shares: 15000,
    pricePerShare: 385.5,
    currency: 'DKK',
    totalValueLocal: 5_782_500,
    sharesOwnedFollowing: null,
    tradeDate: '2026-11-03',
    isin: 'DK0062498333',
  };

  it('gyldigt markedskøb godkendes i lokal valuta', () => {
    const r = validateNordicExtraction(ok, text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ currency: 'DKK', pricePerShare: 385.5, totalValueLocal: 5_782_500 });
  });

  it('tal, der ikke står i teksten, afvises', () => {
    const r = validateNordicExtraction({ ...ok, shares: 20000, totalValueLocal: 20000 * 385.5 }, text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/antallet 20000 findes ikke/);
  });

  it('total ≠ antal × kurs (±2 %) afvises', () => {
    const r = validateNordicExtraction({ ...ok, totalValueLocal: 7_000_000 }, text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/±2 %/);
  });

  it('manglende tal (null fra skemaet), emission og ISIN uden for teksten afvises', () => {
    expect(validateNordicExtraction({ ...ok, shares: null }, text).ok).toBe(false);
    expect(validateNordicExtraction({ ...ok, transactionType: 'ISSUE_PARTICIPATION' }, text).ok).toBe(false);
    expect(validateNordicExtraction({ ...ok, isin: 'SE0000108656' }, text).ok).toBe(false);
  });

  it('ISIN-kontrolciffer', () => {
    expect(isValidIsin('DK0062498333')).toBe(true);
    expect(isValidIsin('DK0062498334')).toBe(false);
  });

  it('regex-reserven udelader tilbagekøb og læser tal med locale', () => {
    const buyback = extractWithRegex({ id: 'b', company: 'X', headline: 'Share buy-back programme', text: 'Volume 10 000', market: '' }, 'da');
    expect(buyback.transactionType).toBe('BUYBACK');
    const purchase = extractWithRegex({ id: 'p', company: 'X', headline: 'Managers transactions – purchase', text, market: '' }, 'da');
    expect(purchase).toMatchObject({ transactionType: 'MARKET_PURCHASE', shares: 15000, pricePerShare: 385.5, isin: 'DK0062498333', currency: 'DKK' });
  });
});

describe('valutasammenligning ved berigelse (audit 1.7)', () => {
  it('insiderkurs i DKK sammenlignes med DKK-kurs; forskellig valuta giver intet afkast', async () => {
    const realFetch = globalThis.fetch;
    const chart = (currency: string, close: number) => ({
      chart: { result: [{ meta: { currency, exchangeName: 'CPH', instrumentType: 'EQUITY' }, indicators: { quote: [{ close: [close, close], high: [close, close], low: [close, close], volume: [1e6, 1e6] }] } }] },
    });
    try {
      globalThis.fetch = (async (url: string) =>
        String(url).includes('/v8/finance/chart/')
          ? new Response(JSON.stringify(chart('DKK', 400)))
          : new Response('', { status: 404 })) as typeof fetch;
      const base = { id: 'n', ticker: 'NOVO-B.CO', companyName: 'Novo', insiderName: 'A B', insiderTitle: 'CEO', transactionCode: 'P' as const, shares: 1, pricePerShare: 385.5, totalValueUsd: 60_000, isClusterBuy: false, secFilingUrl: '' };
      const dkk = await enrichTransactionWithMarketData({ ...base, currency: 'DKK' });
      expect(dkk.returnSinceBuyPct).toBeCloseTo(3.76, 1);
      const usd = await enrichTransactionWithMarketData({ ...base, currency: 'USD', pricePerShare: 55.8 });
      expect(usd.returnSinceBuyPct).toBeUndefined(); // før: "+590 %"
      // Gen-berigelse erstatter markedsblokken i stedet for at hobe gamle kurser op.
      const again = await enrichTransactionWithMarketData({ ...dkk });
      expect(again.contextNotes!.split(MARKET_NOTES_MARKER).length).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
