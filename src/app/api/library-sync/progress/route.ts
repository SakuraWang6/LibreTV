import { libraryRoute, readLibraryJson } from '@/lib/local-library/server';
import { resolveProgress } from '@/lib/library-sync/service';

export const runtime = 'nodejs';
export function POST(request: Request) { return libraryRoute(request, true, async () => resolveProgress(await readLibraryJson(request))); }
