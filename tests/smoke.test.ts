import { describe, expect, it } from 'vitest';
import { isMockEntity } from '@/lib/db';

// Røgtest: bekræfter at vitest kører, at TypeScript transpileres, og at "@/"-aliaset virker.
// Påstandene gælder også efter fase 1, hvor isMockEntity kun skal rense id'er med "mock-".
describe('test-opsætning', () => {
  it('kan importere fra src via @/-alias og kalde isMockEntity', () => {
    expect(isMockEntity('mock-cfo-cluster-buy')).toBe(true);
    expect(isMockEntity('')).toBe(false);
  });
});
