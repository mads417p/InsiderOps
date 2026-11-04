import { describe, expect, it } from 'vitest';
import {
  buildScanRows,
  dedupTrades,
  isExecutiveTitle,
  isValidInsiderName,
  normalizeName,
  parseAndAggregateTransactions,
  parseOpenInsiderTable,
  pickLead,
  rollUpByTicker,
} from '@/lib/sec-scanner';
import type { InsiderTransaction } from '@/types/insider';

let n = 0;
const buy = (over: Partial<InsiderTransaction> = {}): InsiderTransaction => ({
  id: `t${++n}`,
  ticker: 'ACME',
  companyName: 'Acme Corp',
  insiderName: `Person ${n}`,
  insiderTitle: 'Director',
  transactionCode: 'P',
  shares: 10_000,
  pricePerShare: 10,
  totalValueUsd: 100_000,
  tradeDate: '2026-10-20',
  isClusterBuy: false,
  secFilingUrl: 'https://www.sec.gov',
  ...over,
});

describe('cluster og dedup (audit 1.6)', () => {
  it('to direktører samme dato og samme antal aktier er to købere', () => {
    const rows = [
      buy({ insiderName: 'Smith John', ownerCik: '111', accessionNo: '000000000126000001' }),
      buy({ insiderName: 'Jones Mary', ownerCik: '222', accessionNo: '000000000126000002' }),
    ];
    const [lead] = rollUpByTicker(dedupTrades(rows));
    expect(lead.isClusterBuy).toBe(true);
    expect(lead.clusterCount).toBe(2);
  });

  it('samme person fra to kilder (OpenInsider + EDGAR) er én handel og ingen cluster', () => {
    const oi = buy({ id: 'oi-x', insiderName: 'Smith John', ownerCik: '111', accessionNo: '000000000126000001', filedAt: '2026-10-22T16:01:00' });
    const sec = buy({ id: 'sec-x', insiderName: 'SMITH JOHN', ownerCik: '111', accessionNo: '000000000126000001', is10b51Plan: true });
    const unique = dedupTrades([oi, sec]);
    expect(unique).toHaveLength(1);
    expect(unique[0].is10b51Plan).toBe(true); // EDGAR's viden går ikke tabt ved fletningen
    const [lead] = rollUpByTicker(unique);
    expect(lead.isClusterBuy).toBe(false);
    expect(lead.clusterCount).toBe(1);
  });

  it('et salg i samme ticker tæller ikke som køber', async () => {
    const { rows, rejected } = await buildScanRows(
      [buy({ insiderName: 'Smith John' }), buy({ insiderName: 'Seller Sam', transactionCode: 'S' })],
      { enrich: false }
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].isClusterBuy).toBe(false);
    expect(rejected.map((r) => r.insiderName)).toEqual(['Seller Sam']);
    expect(rejected[0].reason).toMatch(/Salg/);
  });

  it('30 dages mellemrum er ikke en cluster (vindue ±10 dage)', () => {
    const [lead] = rollUpByTicker([
      buy({ insiderName: 'Smith John', tradeDate: '2026-09-20' }),
      buy({ insiderName: 'Jones Mary', tradeDate: '2026-10-20' }),
    ]);
    expect(lead.isClusterBuy).toBe(false);
    expect(lead.clusterPeers).toEqual([]);
  });

  it('fond og managing member i samme indberetning (samme accession) er én køber', () => {
    const acc = '000000000126000009';
    const [lead] = rollUpByTicker([
      buy({ insiderName: 'Alpha Fund LP', ownerCik: '501', accessionNo: acc, totalValueUsd: 900_000 }),
      buy({ insiderName: 'Doe Jane', ownerCik: '502', accessionNo: acc, totalValueUsd: 900_000 }),
    ]);
    expect(lead.clusterCount).toBe(1);
    expect(lead.isClusterBuy).toBe(false);
  });

  it('samlet cluster-beløb tæller en fælles indberetning én gang', () => {
    const acc = '000000000126000010';
    const [lead] = rollUpByTicker([
      buy({ insiderName: 'Alpha Fund LP', ownerCik: '501', accessionNo: acc, totalValueUsd: 900_000 }),
      buy({ insiderName: 'Doe Jane', ownerCik: '502', accessionNo: acc, totalValueUsd: 900_000 }),
      buy({ insiderName: 'Roe Rick', ownerCik: '503', accessionNo: '000000000126000011', totalValueUsd: 100_000 }),
    ]);
    expect(lead.clusterCount).toBe(2);
    expect(lead.contextNotes).toMatch(/samlet værdi \$1,000,000/);
  });

  it('lead = største executive-køb, ellers største køb', () => {
    const exec = buy({ insiderName: 'Small Ceo', insiderTitle: 'CEO', isExecutiveOfficer: true, totalValueUsd: 60_000 });
    const dir = buy({ insiderName: 'Big Director', totalValueUsd: 2_000_000 });
    expect(pickLead([dir, exec]).insiderName).toBe('Small Ceo');
    expect(pickLead([dir, buy({ insiderName: 'Mini', totalValueUsd: 70_000 })]).insiderName).toBe('Big Director');
  });

  it('lead vælges i det nyeste vindue – et ældre større køb fortrænger ikke den aktuelle runde', () => {
    const [lead] = rollUpByTicker([
      buy({ insiderName: 'Myers Franklin', insiderTitle: 'CEO', isExecutiveOfficer: true, tradeDate: '2026-08-11', totalValueUsd: 1_279_500 }),
      buy({ insiderName: 'Myers Franklin', insiderTitle: 'CEO', isExecutiveOfficer: true, tradeDate: '2026-10-28', totalValueUsd: 1_108_000 }),
    ]);
    expect(lead.tradeDate).toBe('2026-10-28');
  });

  it('rækker uden handelsdato afvises med årsag', async () => {
    const { rows, rejected } = await buildScanRows([buy({ tradeDate: undefined })], { enrich: false });
    expect(rows).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/Handelsdato mangler/);
  });
});

describe('titler og navne (audit 1.6 / P2)', () => {
  it('isExecutiveTitle matcher på hele ord', () => {
    expect(isExecutiveTitle('Director')).toBe(false); // indeholder "cto"
    expect(isExecutiveTitle('Representative')).toBe(false); // indeholder "pres"
    expect(isExecutiveTitle('10% Owner')).toBe(false);
    expect(isExecutiveTitle('Chairman')).toBe(false);
    expect(isExecutiveTitle('Bestyrelsesmedlem')).toBe(false);
    expect(isExecutiveTitle('Pres, CEO')).toBe(true);
    expect(isExecutiveTitle('EVP & General Counsel')).toBe(true);
    expect(isExecutiveTitle('Director, Chief Financial Officer')).toBe(true);
    expect(isExecutiveTitle('Adm. direktør')).toBe(true);
    expect(isExecutiveTitle('Verkställande direktör')).toBe(true);
  });

  it('isValidInsiderName afviser rene titler', () => {
    for (const t of ['Dir', 'CEO', 'Chief Executive Officer', 'Chairman', 'Bestyrelsesmedlem', 'Verkställande direktör', 'Closely associated person', 'Ledende medarbejder', 'Vice President', '10% Owner', 'N/A']) {
      expect(isValidInsiderName(t), t).toBe(false);
    }
    for (const nm of ['Ford Tamer', 'Rasmus Errboe', 'Novo Holdings A/S', 'Alpha Capital Partners LP', 'Lars Rasmussen']) {
      expect(isValidInsiderName(nm), nm).toBe(true);
    }
  });

  it('normalizeName bevarer æøå og afkorter ikke', () => {
    expect(normalizeName('Rasmussen, Lars')).toBe('rasmussen lars');
    expect(normalizeName('Rasmussen Lene')).not.toBe(normalizeName('Rasmussen Lars'));
    expect(normalizeName('Søren Ærø')).toBe('søren ærø');
  });
});

describe('Form 4-parser', () => {
  const nd = (code: string, ad: string, shares: number, price: number, date: string, owned?: number) =>
    `<nonDerivativeTransaction><transactionDate><value>${date}</value></transactionDate><transactionCoding><transactionCode>${code}</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>${shares}</value></transactionShares><transactionPricePerShare><value>${price}</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>${ad}</value></transactionAcquiredDisposedCode></transactionAmounts>${
      owned !== undefined ? `<postTransactionAmounts><sharesOwnedFollowingTransaction><value>${owned}</value></sharesOwnedFollowingTransaction></postTransactionAmounts>` : ''
    }</nonDerivativeTransaction>`;

  it('derivat-linjer med kode P bliver aldrig et aktiekøb', () => {
    const xml = `<derivativeTable><derivativeTransaction><transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></derivativeTransaction></derivativeTable>`;
    expect(parseAndAggregateTransactions(xml)).toBeNull();
  });

  it('split-lots summeres; handelsdato = seneste P-dato; ukendt beholdning → undefined (ikke 100 %)', () => {
    const r = parseAndAggregateTransactions(nd('P', 'A', 1000, 10, '2026-10-20') + nd('P', 'A', 1000, 12, '2026-10-21'))!;
    expect(r.code).toBe('P');
    expect(r.shares).toBe(2000);
    expect(r.totalValueUsd).toBe(22_000);
    expect(r.tradeDate).toBe('2026-10-21');
    expect(r.holdingsIncreasePct).toBeUndefined();
    const withOwned = parseAndAggregateTransactions(nd('P', 'A', 1000, 10, '2026-10-20', 5000))!;
    expect(withOwned.holdingsIncreasePct).toBe(25);
  });
});

describe('OpenInsider-parser', () => {
  const header = `<tr><th>X</th><th>Filing Date</th><th>Trade Date</th><th>Ticker</th><th>Company Name</th><th>Insider Name</th><th>Title</th><th>Trade Type</th><th>Price</th><th>Qty</th><th>Owned</th><th>&Delta;Own</th><th>Value</th></tr>`;
  const row = (type: string, delta: string) =>
    `<tr><td></td><td><div><a href="http://www.sec.gov/Archives/edgar/data/855658/000143774926034881/xslF345X03/rdgdoc.xml">2026-11-04 14:35:56</a></div></td><td><div>2026-11-03</div></td><td><b><a href="/LSCC">LSCC</a></b></td><td><a href="/LSCC">Lattice Semiconductor Corp</a></td><td><a href="/insider/Tamer-Ford/1541375" title="335,467 indirect shares">Tamer Ford</a></td><td>Pres, CEO</td><td>${type}</td><td>$102.52</td><td>+9,790</td><td>335,467</td><td>${delta}</td><td>+$1,003,689</td></tr>`;
  const html = (rows: string) => `<table class="tinytable">${header}${rows}</table>`;

  it('læser handelsdato, accept-tid, accession, CIK og kode fra Trade Type', () => {
    const [tx] = parseOpenInsiderTable(html(row('P - Purchase', '+3%')), 'live-buy');
    expect(tx).toMatchObject({
      id: 'oi-000143774926034881-1541375',
      tradeDate: '2026-11-03',
      filedAt: '2026-11-04T14:35:56',
      accessionNo: '000143774926034881',
      ownerCik: '1541375',
      transactionCode: 'P',
      shares: 9790,
      totalValueUsd: 1_003_689,
      holdingsIncreasePct: 3,
      ownershipNature: 'I',
      isExecutiveOfficer: true,
      secFilingUrl: 'https://www.sec.gov/Archives/edgar/data/855658/000143774926034881/xslF345X03/rdgdoc.xml',
    });
  });

  it('"New" i ΔOwn giver undefined, og salg får kode S', () => {
    const [p, s] = parseOpenInsiderTable(html(row('P - Purchase', 'New') + row('S - Sale+OE', '-5%')), 'x');
    expect(p.holdingsIncreasePct).toBeUndefined();
    expect(s.transactionCode).toBe('S');
  });

  it('ingen tabel på en screenerside = 0 rækker; en ukendt side kaster', () => {
    expect(parseOpenInsiderTable('<form>Sort by Filing Date … Max Results</form>', 'x')).toEqual([]);
    expect(() => parseOpenInsiderTable('<html>Service Unavailable</html>', 'x')).toThrow(/kunne ikke læses/);
  });
});

describe('migrate-legacy-dates', () => {
  it('sec- → tradeDate, OpenInsider/nordic → filedAt, idempotent', async () => {
    const { migrateTransaction } = await import('../scripts/migrate-legacy-dates');
    const sec = { id: 'sec-APLD-1', filingDate: '2026-10-19' } as unknown as InsiderTransaction;
    const oi = { id: 'exec-buy-DINO-2026-10-29-1', filingDate: '2026-10-29' } as unknown as InsiderTransaction;
    expect(migrateTransaction(sec)).toBe(true);
    expect(migrateTransaction(oi)).toBe(true);
    expect(sec).toEqual({ id: 'sec-APLD-1', tradeDate: '2026-10-19' });
    expect(oi).toEqual({ id: 'exec-buy-DINO-2026-10-29-1', filedAt: '2026-10-29' });
    expect(migrateTransaction(oi)).toBe(false);
  });
});
