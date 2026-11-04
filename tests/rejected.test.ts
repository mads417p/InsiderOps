import { describe, expect, it } from 'vitest';
import { buildScanRows } from '@/lib/sec-scanner';
import { collectRejected } from '@/lib/ui-labels';
import type { InsiderTransaction } from '@/types/insider';

const tx = (over: Partial<InsiderTransaction> = {}): InsiderTransaction => ({
  id: 'x',
  ticker: 'ACME',
  companyName: 'Acme Corp',
  insiderName: 'Seller Sam',
  insiderTitle: 'Director',
  transactionCode: 'S',
  shares: 10_000,
  pricePerShare: 10,
  totalValueUsd: 100_000,
  tradeDate: '2026-10-20',
  isClusterBuy: false,
  secFilingUrl: 'https://www.sec.gov',
  ...over,
});

describe('afvist støj (fase 2.5, 3)', () => {
  it('samme handel fra OpenInsider og EDGAR afvises og tælles én gang', async () => {
    const same = { accessionNo: '000119312526430504', ownerCik: '1234' };
    const { rejected } = await buildScanRows(
      [tx({ id: 'oi-1', ...same }), tx({ id: 'sec-1', ...same }), tx({ id: 'oi-2', insiderName: 'Grant Gina', transactionCode: 'A' })],
      { enrich: false }
    );
    expect(rejected.map((r) => r.id)).toEqual(['oi-1', 'oi-2']);
  });

  it('tæller alle afviste: pipelinens liste + items, der ikke bestod hard-filteret, uden dobbelttælling', () => {
    const scanRejected = [
      { id: 'a', ticker: 'AAA', insiderName: 'X', reason: 'Salg' },
      { id: 'b', ticker: 'BBB', insiderName: 'Y', reason: 'Penny stock' },
    ];
    const items = [
      { transaction: { id: 'c', ticker: 'CCC', insiderName: 'Z' }, result: { passedHardFilter: false, hardFilterReason: 'OTC' } },
      { transaction: { id: 'a', ticker: 'AAA', insiderName: 'X' }, result: { passedHardFilter: false } }, // allerede talt
      { transaction: { id: 'd', ticker: 'DDD', insiderName: 'W' }, result: { passedHardFilter: true } },
    ];
    const all = collectRejected(scanRejected, items);
    expect(all.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(all[2].reason).toBe('OTC');
  });
});
