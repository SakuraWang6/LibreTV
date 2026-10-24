import { libraryRoute, mediaResponse } from '@/lib/local-library/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };

export function GET(request: Request, context: Context) {
  return libraryRoute(request, false, async () => mediaResponse((await context.params).id, request));
}

export function HEAD(request: Request, context: Context) {
  return libraryRoute(request, false, async () => mediaResponse((await context.params).id, request));
}
