import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { isLocalAuthBypass } from '@/lib/auth';
import { browserBridgeConfigured, getLibvioBrowserStatus, openLibvioBrowser } from '@/lib/providers/libvio/browser-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function permitted(request: Request) {
  // Only the Mac launcher's authenticated loopback listener may control its
  // dedicated browser. A public deployment never exposes browser controls.
  return browserBridgeConfigured() && isLocalAuthBypass(request);
}

export async function GET(request: Request) {
  const guarded = guardRequest(request);
  if (guarded) return guarded;
  if (!permitted(request)) return NextResponse.json({ enabled: false });
  try {
    const status = await getLibvioBrowserStatus(request.signal);
    return NextResponse.json({ enabled: true, connected: status.browserOpen, verified: status.verified });
  } catch {
    return NextResponse.json({ enabled: true, connected: false, verified: false });
  }
}

export async function POST(request: Request) {
  const guarded = guardRequest(request);
  if (guarded) return guarded;
  if (!permitted(request)) return NextResponse.json({ error: '此功能仅在 Mac 本机可用' }, { status: 403 });
  try {
    const status = await openLibvioBrowser(request.signal);
    return NextResponse.json({ enabled: true, connected: status.browserOpen, verified: status.verified });
  } catch {
    return NextResponse.json({ error: 'Chrome 连接失败，请稍后重试' }, { status: 503 });
  }
}
