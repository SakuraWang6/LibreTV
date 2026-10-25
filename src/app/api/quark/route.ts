import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { isLocalAuthBypass } from '@/lib/auth';
import { completeQuarkLogin, quarkConfigured, quarkStatus, startQuarkLogin } from '@/lib/quark/runtime';
import { readLibraryJson } from '@/lib/local-library/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
function quarkRequestAllowed(request: Request) { return quarkConfigured() && isLocalAuthBypass(request); }
export async function GET(request: Request) {
  const guarded = guardRequest(request); if (guarded) return guarded;
  if (!quarkRequestAllowed(request)) return NextResponse.json({ enabled: false, connected: false, pending: false });
  try { return NextResponse.json(await quarkStatus()); }
  catch { return NextResponse.json({ enabled: true, connected: false, pending: false }); }
}
export async function POST(request: Request) {
  const guarded = guardRequest(request); if (guarded) return guarded;
  if (!quarkRequestAllowed(request)) return NextResponse.json({ error: '夸克账号连接仅在 Mac 本机可用' }, { status: 403 });
  try {
    const body = await readLibraryJson(request) as { action?: unknown; code?: unknown };
    if (body.action === 'login') return NextResponse.json(await startQuarkLogin());
    if (body.action === 'complete-login') return NextResponse.json(await completeQuarkLogin(typeof body.code === 'string' ? body.code : ''));
    if (body.action === 'check-login') return NextResponse.json(await quarkStatus());
    return NextResponse.json({ error: '不支持的夸克操作' }, { status: 400 });
  } catch (error) {
    const known = error as { status?: number; message?: string };
    return NextResponse.json({ error: known.status ? known.message : '夸克连接失败，请重试' }, { status: known.status || 503 });
  }
}
