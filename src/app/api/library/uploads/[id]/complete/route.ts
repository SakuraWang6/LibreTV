import { completeUpload, libraryRoute } from '@/lib/local-library/server';

export const runtime = 'nodejs';

export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return libraryRoute(request, true, async () => completeUpload((await context.params).id));
}
