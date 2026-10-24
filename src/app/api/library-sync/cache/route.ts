import { libraryRoute, readLibraryJson } from '@/lib/local-library/server';
import { enqueueCache } from '@/lib/library-sync/service';

export const runtime = 'nodejs';
export function POST(request: Request) { return libraryRoute(request, true, async () => enqueueCache(await readLibraryJson(request))); }
