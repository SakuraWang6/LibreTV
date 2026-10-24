import { libraryRoute } from '@/lib/local-library/server';
import { deleteDownload } from '@/lib/background-downloads/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return libraryRoute(request, true, async () => deleteDownload((await context.params).id));
}
