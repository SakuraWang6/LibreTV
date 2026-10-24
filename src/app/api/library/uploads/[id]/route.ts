import { appendUpload, cancelUpload, libraryRoute } from '@/lib/local-library/server';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export function PUT(request: Request, context: Context) {
  return libraryRoute(request, true, async () => {
    const offset = new URL(request.url).searchParams.get('offset');
    return appendUpload((await context.params).id, offset && /^\d+$/.test(offset) ? Number(offset) : NaN, request);
  });
}

export function DELETE(request: Request, context: Context) {
  return libraryRoute(request, true, async () => cancelUpload((await context.params).id));
}
