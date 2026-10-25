import { NextResponse } from 'next/server';
import { libraryRoute, readLibraryJson } from '@/lib/local-library/server';
import { isLocalAuthBypass } from '@/lib/auth';
import { enqueueQuarkFiles } from '@/lib/quark/service';
import { quarkConfigured } from '@/lib/quark/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request) {
  if (!quarkConfigured() || !isLocalAuthBypass(request)) return NextResponse.json({ error: '夸克分享下载仅在 Mac 本机可用' }, { status: 403 });
  return libraryRoute(request, true, async () => enqueueQuarkFiles(await readLibraryJson(request)));
}
