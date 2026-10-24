import { libraryRoute } from '@/lib/local-library/server';
import { retryDownload } from '@/lib/background-downloads/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return libraryRoute(request, true, async () => retryDownload((await context.params).id));
}
