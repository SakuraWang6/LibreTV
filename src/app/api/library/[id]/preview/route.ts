import { libraryRoute } from '@/lib/local-library/server';
import { libraryPreviewResponse } from '@/lib/local-library/preview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const response = await libraryRoute(request, false, async () => libraryPreviewResponse((await context.params).id, request));
  if (response.status === 503) response.headers.set('Retry-After', '1');
  return response;
}
