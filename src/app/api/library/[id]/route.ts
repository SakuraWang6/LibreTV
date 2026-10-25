import { libraryRoute, readLibraryJson, updateProgress } from '@/lib/local-library/server';

export const runtime = 'nodejs';

export function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return libraryRoute(request, true, async () => updateProgress((await context.params).id, await readLibraryJson(request), request));
}
