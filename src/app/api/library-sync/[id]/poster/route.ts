import { libraryRoute } from '@/lib/local-library/server';
import { syncPoster } from '@/lib/library-sync/service';

export const runtime = 'nodejs';
export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return libraryRoute(request, false, async () => syncPoster((await context.params).id, request.signal));
}
