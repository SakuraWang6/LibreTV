import { libraryRoute, posterResponse } from '@/lib/local-library/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return libraryRoute(request, false, async () => posterResponse((await context.params).id));
}
