import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractOfferingPrices, isOfferingFootnote, matchOffering, type Offering } from '@/lib/offering-check';
import {
  annotateForm4Details,
  detectOwnershipNature,
  ownershipFromLines,
  parseForm4PurchaseLines,
  rollUpByTicker,
} from '@/lib/sec-scanner';
import type { InsiderTransaction } from '@/types/insider';
import { excludeOfferingBuys } from '@/lib/track-record';

// Uddrag af RAPP's prospekter (SEC EDGAR, hentet 4.11.2026).
const RAPP_424B5 = `<p>We are offering 8,333,334 shares of our common stock … at a public offering price of $21.00 per share, and, in lieu of
common stock, pre-funded warrants … at a public offering price of $20.999 (the &#8220;concurrent equity offering&#8221;).</p>
<p>… in a concurrent private placement … at a per share price of $21.00, which is the offering price.</p>`;
const RAPP_424B4 = '<p>This is the initial public offering of Rapport Therapeutics. The initial public offering price is $17.00 per share.</p>';
const ATM = '<p>Sales of our common stock, if any, will be made in "at the market offerings" at prevailing market prices.</p>';

// Forkortet Form 4 for James Healy, RAPP, 28.10.2026 (accession 0001104659-26-120789): 2 af 4 linjer.
const HEALY_XML = `<?xml version="1.0"?><ownershipDocument>
<issuer><issuerCik>0002012593</issuerCik><issuerTradingSymbol>RAPP</issuerTradingSymbol></issuer>
<nonDerivativeTable>
<nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle>
<transactionDate><value>2026-10-28</value></transactionDate>
<transactionCoding><transactionFormType>4</transactionFormType><transactionCode>P</transactionCode></transactionCoding>
<transactionAmounts><transactionShares><value>952380</value></transactionShares><transactionPricePerShare><value>21.00</value></transactionPricePerShare>
<transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
<ownershipNature><directOrIndirectOwnership><value>I</value></directOrIndirectOwnership>
<natureOfOwnership><value>By Sofinnova Venture Partners XI, L.P.</value><footnoteId id="F1"/></natureOfOwnership></ownershipNature>
</nonDerivativeTransaction>
<nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle>
<transactionDate><value>2026-10-28</value></transactionDate>
<transactionCoding><transactionFormType>4</transactionFormType><transactionCode>P</transactionCode></transactionCoding>
<transactionAmounts><transactionShares><value>6395</value></transactionShares><transactionPricePerShare><value>21.00</value></transactionPricePerShare>
<transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
<ownershipNature><directOrIndirectOwnership><value>I</value></directOrIndirectOwnership>
<natureOfOwnership><value>By SummitTX Master, SPC -SummitTX Apex SP - Healthcare 3</value><footnoteId id="F2"/></natureOfOwnership></ownershipNature>
</nonDerivativeTransaction>
</nonDerivativeTable>
<footnotes>
<footnote id="F1">The shares are directly held by Sofinnova Venture Partners XI, L.P. (&quot;SVP XI&quot;). The Reporting Person is a managing member of SM XI.</footnote>
<footnote id="F2">The shares are directly held by SummitTX Master, SPC - SummitTX Apex SP - Healthcare 3.</footnote>
</footnotes></ownershipDocument>`;

const offering = (over: Partial<Offering> = {}): Offering => ({ form: '424B5', filingDate: '2026-10-30', price: 21, url: 'https://www.sec.gov/x', ...over });

describe('udbudskurs fra prospekter (fase 2.5, 5b)', () => {
  it('424B5 og 424B4 giver kursen pr. aktie; ATM giver ingen', () => {
    expect(extractOfferingPrices(RAPP_424B5)).toEqual([21]); // $20,999 er warrant-prisen (ikke "per share")
    expect(extractOfferingPrices(RAPP_424B4)).toEqual([17]);
    expect(extractOfferingPrices(ATM)).toEqual([]);
  });

  it('match kræver præcis samme kurs og prospekt inden for ±7 dage', () => {
    expect(matchOffering({ tradeDate: '2026-10-28', price: 21 }, [offering()])?.form).toBe('424B5');
    expect(matchOffering({ tradeDate: '2026-10-21', price: 27.25 }, [offering()])).toBeUndefined();
    expect(matchOffering({ tradeDate: '2026-09-01', price: 21 }, [offering()])).toBeUndefined();
    expect(matchOffering({ tradeDate: '2024-06-10', price: 17 }, [offering({ form: '424B4', filingDate: '2024-06-07', price: 17 })])?.form).toBe('424B4');
  });

  it('fodnote om udbud/private placement genkendes; ejerkæde- og kursfodnoter gør ikke', () => {
    expect(isOfferingFootnote('Shares acquired in a private placement pursuant to a Securities Purchase Agreement dated October 28, 2026')).toBe(true);
    expect(isOfferingFootnote('Purchased in the Issuer’s initial public offering at the IPO price.')).toBe(true);
    expect(isOfferingFootnote('The shares are directly held by Sofinnova Venture Partners XI, L.P.')).toBe(false);
    expect(isOfferingFootnote('The price reported in Column 4 is a weighted average price.')).toBe(false);
  });
});

describe('D/I pr. købslinje (fase 2.5, 5a)', () => {
  it('Healy: indirekte via Sofinnova, kurs og dato pr. linje, refererede fodnoter', () => {
    const lines = parseForm4PurchaseLines(HEALY_XML);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ tradeDate: '2026-10-28', shares: 952380, price: 21, ownership: 'I', via: 'By Sofinnova Venture Partners XI, L.P.' });
    expect(lines[0].footnotes[0]).toMatch(/directly held by Sofinnova/);
    expect(ownershipFromLines(lines)).toEqual({ ownership: 'I', via: 'By Sofinnova Venture Partners XI, L.P.' });
    expect(ownershipFromLines([{ ...lines[0], ownership: 'D' }, lines[1]]).ownership).toBe('D');
    expect(ownershipFromLines([{ ...lines[0], ownership: undefined }])).toEqual({});
  });

  it('OpenInsider-hint: "indirect shares" er indirekte (før matchede "direct shares" først); ukendt er undefined', () => {
    expect(detectOwnershipNature(undefined, 'Healy James', '<a title="indirect shares">')).toBe('I');
    expect(detectOwnershipNature(undefined, 'Healy James', '<a title="direct shares">')).toBe('D');
    expect(detectOwnershipNature(undefined, 'Healy James', '')).toBeUndefined();
  });
});

let n = 0;
const buy = (over: Partial<InsiderTransaction> = {}): InsiderTransaction => ({
  id: `b${++n}`,
  ticker: 'RAPP',
  companyName: 'Rapport Therapeutics',
  insiderName: `Person ${n}`,
  insiderTitle: 'Director',
  transactionCode: 'P',
  shares: 1000,
  pricePerShare: 27,
  totalValueUsd: 27_000,
  tradeDate: '2026-10-21',
  isClusterBuy: false,
  secFilingUrl: 'https://www.sec.gov',
  ...over,
});

describe('købere i et cluster (fase 2.5, 5a/5d)', () => {
  it('personlige mod fonds-købere; udbudsmarkering pr. køber; cluster-tal uændret', () => {
    const [lead] = rollUpByTicker([
      buy({ insiderName: 'Ignelzi Troy A.', ownerCik: '1', accessionNo: '000119312526428018', ownershipNature: 'D', totalValueUsd: 136_250, isExecutiveOfficer: true }),
      buy({
        insiderName: 'Healy James', ownerCik: '2', accessionNo: '000110465926120789', ownershipNature: 'I',
        ownershipVia: 'By Sofinnova Venture Partners XI, L.P.', tradeDate: '2026-10-28', pricePerShare: 21,
        shares: 969_480, totalValueUsd: 20_359_080, offeringNote: 'Mulig deltagelse i udbud: 424B5 2026-10-30 til $21.00 pr. aktie',
      }),
      buy({ insiderName: 'Third Rock Ventures V, L.P.', ownerCik: '3', accessionNo: '000119312526445438', ownershipNature: 'D', tradeDate: '2026-10-28' }),
      buy({ insiderName: 'Silva Paul M', ownerCik: '4', accessionNo: '000119312526429075' }), // D/I ukendt
    ]);
    expect(lead.clusterCount).toBe(4); // beslutning: kun markér – udbudskøb tæller stadig med
    expect(lead.personalBuyers).toBe(1);
    expect(lead.fundBuyers).toBe(2); // Healy via fond + Third Rock (entity, der selv indberetter)
    const healy = lead.clusterBuyers!.find((b) => b.name === 'Healy James')!;
    expect(healy).toMatchObject({ ownership: 'I', price: 21, offeringNote: expect.stringMatching(/424B5/) });
    expect(lead.clusterBuyers!.find((b) => b.name === 'Silva Paul M')!.ownership).toBeUndefined();
  });
});

describe('annotateForm4Details mod SEC (fetch stubbet)', () => {
  beforeEach(() => vi.stubEnv('SEC_USER_AGENT', 'InsiderOps-test (test@example.com)'));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('OpenInsider-række: D/I og via fra XML, udbud fra 424B5-kursen, offeringChecked sat', async () => {
    const submissions = {
      filings: { recent: { form: ['4', '424B5'], filingDate: ['2026-10-30', '2026-10-30'], accessionNumber: ['0001104659-26-120789', '0001193125-26-439869'], primaryDocument: ['x.xml', 'd98241d424b5.htm'] } },
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/submissions/')) return new Response(JSON.stringify(submissions), { status: 200 });
      if (url.endsWith('d98241d424b5.htm')) return new Response(RAPP_424B5, { status: 200 });
      if (url.includes('tm2628672')) return new Response(HEALY_XML, { status: 200 });
      return new Response('nej', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tx = buy({
      insiderName: 'Healy James', tradeDate: '2026-10-28', pricePerShare: 21, ownershipNature: undefined,
      secFilingUrl: 'https://www.sec.gov/Archives/edgar/data/2012593/000110465926120789/xslF345X06/tm2628672-1_4seq1.xml',
    });
    await annotateForm4Details([tx]);
    expect(tx).toMatchObject({ ownershipNature: 'I', ownershipVia: 'By Sofinnova Venture Partners XI, L.P.', issuerCik: '2012593', offeringChecked: true });
    expect(tx.offeringNote).toMatch(/424B5 2026-10-30 til \$21\.00/);
  });
});

describe('track record udelader køb i IPO/udbud (fase 2.5, 5c)', () => {
  it('Healy-fondenes IPO-køb 10.6.2024 á $17,00 udelades; markedskøb beholdes', () => {
    const ipo = offering({ form: '424B4', filingDate: '2024-06-07', price: 17 });
    const buys = [
      { date: '2024-06-10', insiderName: 'Healy James', price: 17, valueUsd: 10_000_000 },
      { date: '2024-06-10', insiderName: 'Third Rock Ventures', price: 17, valueUsd: 15_000_000 },
      { date: '2025-03-04', insiderName: 'Ignelzi Troy A.', price: 9.8, valueUsd: 120_000 },
    ];
    const { kept, excluded } = excludeOfferingBuys(buys, [ipo]);
    expect(excluded.map((b) => b.insiderName)).toEqual(['Healy James', 'Third Rock Ventures']);
    expect(kept.map((b) => b.insiderName)).toEqual(['Ignelzi Troy A.']);
  });
});
