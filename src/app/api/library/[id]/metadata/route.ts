import { libraryRoute, readLibraryJson, updateLibraryMetadata } from '@/lib/local-library/server';

export const runtime = 'nodejs';

export function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return libraryRoute(request, true, async () => updateLibraryMetadata((await context.params).id, await readLibraryJson(request), request));
}
