import path from 'path';
import { NextResponse } from 'next/server';
import { resetAppData } from '@/lib/db';

/**
 * POST /api/reset { confirm: "NULSTIL" } – kun fra knappen "Nulstil data".
 * Sletter domme og paper-positioner (backup i data/backups/ først). Scans, Nordnet-handler og signal-ledgeren bevares.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (body?.confirm !== 'NULSTIL') {
    return NextResponse.json({ success: false, error: 'Bekræftelse mangler – intet er slettet' }, { status: 400 });
  }
  try {
    const res = await resetAppData();
    return NextResponse.json({ success: true, ...res, backup: res.backup && path.relative(process.cwd(), res.backup) });
  } catch (error) {
    console.error('Fejl i POST /api/reset:', error);
    return NextResponse.json({ success: false, error: 'Nulstillingen fejlede – intet er slettet' }, { status: 500 });
  }
}
