import { describe, expect, it } from 'vitest';
import { generateTradeExecutionPlan } from '@/lib/trade-planner';
import { verifyDkTradability } from '@/lib/market-enricher';
import type { CouncilVerdict, InsiderTransaction } from '@/types/insider';

const tx = (over: Partial<InsiderTransaction> = {}) =>
  ({ id: 't1', ticker: 'ACN', companyName: 'Accenture plc', pricePerShare: 250, ...over }) as InsiderTransaction;
const verdict = { asymmetryScore: 85, verdict: 'STRONG ASYMMETRY (KØB)' } as CouncilVerdict;

describe('trade-planner uden opfundne tal', () => {
  it('uden ATR → DO_NOT_TRADE "Data mangler"', () => {
    const plan = generateTradeExecutionPlan(tx({ currentMarketPrice: 260 }), verdict);
    expect(plan.status).toBe('DO_NOT_TRADE');
    expect(plan.reason).toMatch(/Data mangler.*ATR14/);
  });

  it('uden live-kurs → DO_NOT_TRADE, selvom insiderkursen findes', () => {
    const plan = generateTradeExecutionPlan(tx({ atr14d: 5 }), verdict);
    expect(plan.status).toBe('DO_NOT_TRADE');
    expect(plan.reason).toMatch(/Data mangler.*live-kurs/);
  });

  it('med kurs og ATR → ACTIVE_PLAN', () => {
    const plan = generateTradeExecutionPlan(tx({ currentMarketPrice: 260, atr14d: 5 }), verdict);
    expect(plan.status).toBe('ACTIVE_PLAN');
    expect(plan.stopLossPrice).toBeGreaterThan(0);
  });
});

describe('verifyDkTradability', () => {
  it('manglende metadata → undefined, aldrig "Verificeret" (insiderkurs bruges ikke som markedskurs)', () => {
    const r = verifyDkTradability(tx());
    expect(r.isTradableInDK).toBeUndefined();
    expect(r.tradabilityReason).toMatch(/^Ikke verificeret – data mangler/);
  });

  it('OTC og børser uden for listen → false', () => {
    expect(verifyDkTradability(tx(), { exchangeName: 'PNK', fullExchangeName: 'OTC Markets' }).isTradableInDK).toBe(false);
    expect(verifyDkTradability(tx(), { exchangeName: 'LSE', fullExchangeName: 'London' }).isTradableInDK).toBe(false);
  });

  it('fuld data på en godkendt børs → true og "Verificeret"', () => {
    const r = verifyDkTradability(tx(), {
      exchangeName: 'NYQ',
      fullExchangeName: 'NYSE',
      instrumentType: 'EQUITY',
      currency: 'USD',
      currentPrice: 260,
      avgDailyDollarVolume: 500_000_000,
    });
    expect(r.isTradableInDK).toBe(true);
    expect(r.exchange).toBe('NYSE');
    expect(r.tradabilityReason).toMatch(/^Verificeret: NYSE/);
  });
});
