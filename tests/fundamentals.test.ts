import { describe, expect, it } from 'vitest';
import {
  deriveHealthBadge,
  extractCashAndEquivalents,
  extractTotalDebt,
  parseFinvizEarnings,
  parseNasdaqEarnings,
  type XbrlConcept,
} from '@/lib/fundamentals';

const fact = (end: string, val: number, form = '10-K') => ({ end, val, form, filed: end });
const concept = (...items: ReturnType<typeof fact>[]): XbrlConcept => ({ units: { USD: items } });

describe('XBRL cash og gæld', () => {
  it('manglende cash- og gælds-tags giver undefined, ikke 0', () => {
    const gaap = { Revenues: concept(fact('2026-08-31', 1_000_000)) };
    expect(extractCashAndEquivalents(gaap)).toBeUndefined();
    expect(extractTotalDebt(gaap)).toBeUndefined();
  });

  it('ACN: langfristet gæld i LongTermDebtAndCapitalLeaseObligations + DebtCurrent ≈ $10,11 mia.', () => {
    // Tal fra SEC companyfacts CIK 1467373 (hentet 4.11.2026). ACN har ingen LongTermDebt/LongTermDebtNoncurrent.
    const gaap = {
      DebtCurrent: concept(fact('2026-05-31', 112_816_000, '10-Q'), fact('2026-08-31', 113_069_000)),
      LongTermDebtAndCapitalLeaseObligations: concept(
        fact('2026-05-31', 5_029_449_000, '10-Q'),
        fact('2026-08-31', 9_998_689_000)
      ),
    };
    expect(extractTotalDebt(gaap)).toBe(10_111_758_000);
  });

  it('cash læses fra cash-tags på nyeste dato; restricted cash bruges som reserve', () => {
    const gaap = {
      CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents: concept(fact('2026-08-31', 400_000_000)),
      ShortTermInvestments: concept(fact('2026-08-31', 36_000_000)),
    };
    expect(extractCashAndEquivalents(gaap)).toBe(436_000_000);
  });

  it('kortfristede investeringer alene giver ikke cash = 0 (cash-datoen bestemmer)', () => {
    const gaap = {
      CashAndCashEquivalentsAtCarryingValue: concept(fact('2026-06-30', 50_000_000, '10-Q')),
      ShortTermInvestments: concept(fact('2026-09-30', 10_000_000, '10-Q')),
    };
    expect(extractCashAndEquivalents(gaap)).toBe(50_000_000);
  });
});

describe('sundhedsbadge', () => {
  it('ukendt cash flow / runway giver UNKNOWN – aldrig SOLID_RUNWAY', () => {
    expect(deriveHealthBadge({})).toBe('UNKNOWN');
    expect(deriveHealthBadge({ shortPercentOfFloat: 25 })).toBe('UNKNOWN');
    expect(deriveHealthBadge({ isCashFlowPositive: false })).toBe('UNKNOWN');
  });

  it('kendte tal giver de normale badges', () => {
    expect(deriveHealthBadge({ isCashFlowPositive: false, estimatedRunwayMonths: 5 })).toBe('DILUTION_RISK');
    expect(deriveHealthBadge({ isCashFlowPositive: true, estimatedRunwayMonths: null, netCashUsd: 1e9 })).toBe(
      'FORTRESS_BALANCE'
    );
    // Gæld ukendt → netCash ukendt → ingen FORTRESS
    expect(deriveHealthBadge({ isCashFlowPositive: true, estimatedRunwayMonths: null })).toBe('SOLID_RUNWAY');
    expect(deriveHealthBadge({ isCashFlowPositive: false, estimatedRunwayMonths: 10 })).toBe('NEUTRAL');
  });
});

describe('næste regnskabsdato', () => {
  const now = new Date(2026, 10, 4, 12); // 4.11.2026 lokal tid

  it('Finviz-dato i fortiden kasseres (RAPP viste august)', () => {
    expect(parseFinvizEarnings('Aug 07 BMO', now)).toEqual({});
    expect(parseFinvizEarnings('Nov 05 AMC', now)).toEqual({ nextEarningsDate: '2026-11-05', daysUntilEarnings: 1 });
    expect(parseFinvizEarnings('-', now)).toEqual({});
  });

  it('Nasdaq-dato parses og markeres som estimat; fortid og null giver ukendt', () => {
    expect(
      parseNasdaqEarnings(
        {
          announcement: 'Earnings announcement* for ACN: Dec 17, 2026',
          reportText: 'Accenture plc is estimated to report earnings on  12/17/2026.',
        },
        now
      )
    ).toEqual({ nextEarningsDate: '2026-12-17', daysUntilEarnings: 43, nextEarningsDateEstimated: true });
    expect(parseNasdaqEarnings({ announcement: 'Earnings announcement* for X: Aug 1, 2026' }, now)).toEqual({});
    expect(parseNasdaqEarnings(null, now)).toEqual({});
  });
});
