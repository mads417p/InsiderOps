import { z } from 'zod';

/**
 * zod-skemaer for alle muterende API-kald (POST/PATCH/DELETE). Tal skal være endelige (z.number afviser
 * NaN/Infinity), priser positive, og id'er må ikke kunne ramme Object.prototype.
 */

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((id) => !FORBIDDEN_KEYS.has(id), { message: 'Ugyldigt id' });

const ticker = z.string().trim().regex(/^[A-Za-z0-9.\-]{1,15}$/, 'Ugyldig ticker');
const text = z.string().max(300);
const positive = z.number().positive();
const nonNegative = z.number().min(0);

export const councilPostSchema = z.strictObject({
  id: idSchema, // transaktionen hentes server-side – klientens data bruges ikke
  judgeTier: z.enum(['opus', 'sonnet']).optional(),
  forceRefresh: z.boolean().optional(),
});

export const portfolioPostSchema = z.strictObject({
  id: idSchema.optional(),
  ticker,
  companyName: text.optional(),
  exchange: text.optional(),
  insiderName: text.optional(),
  insiderTitle: text.optional(),
  asymmetryScore: z.number().int().min(0).max(100),
  insiderBuyPrice: positive,
  shares: positive.optional(),
  investedDkk: positive.optional(),
  stopLossPrice: nonNegative.optional(),
  targetPrice: nonNegative.optional(),
  tradeType: z.enum(['PAPER', 'REAL_NORDNET']).optional(),
});

export const portfolioPatchSchema = z.union([
  z.strictObject({ id: idSchema, action: z.literal('close'), exitPrice: positive.optional() }),
  z.strictObject({
    id: idSchema,
    tradeType: z.enum(['PAPER', 'REAL_NORDNET']).optional(),
    entryPrice: positive.optional(),
    shares: positive.optional(),
    stopLossPrice: nonNegative.optional(),
    targetPrice: nonNegative.optional(),
  }),
]);

/** POST /api/scan: genberig kurser for transaktioner, klienten allerede har (kun markedsdata). */
export const scanPostSchema = z.object({
  transactions: z.array(z.looseObject({ id: idSchema, ticker })).max(100),
});

/** Parser body med et skema; ved fejl en dansk fejltekst til et 400-svar. */
export async function parseJson<T>(
  request: Request,
  schema: z.ZodType<T>
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, error: 'Ugyldig JSON i forespørgslen' };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ');
    return { ok: false, error: `Ugyldig forespørgsel – ${issues}` };
  }
  return { ok: true, data: result.data };
}
