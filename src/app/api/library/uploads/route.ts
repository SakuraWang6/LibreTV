import { createUpload, libraryRoute, readLibraryJson } from '@/lib/local-library/server';

export const runtime = 'nodejs';

export function POST(request: Request) {
  return libraryRoute(request, true, async () => createUpload(await readLibraryJson(request)));
}
