import { libraryRoute, readLibraryJson } from '@/lib/local-library/server';
import { enqueueDownload, listDownloads } from '@/lib/background-downloads/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) { return libraryRoute(request, false, listDownloads); }
export function POST(request: Request) { return libraryRoute(request, true, async () => enqueueDownload(await readLibraryJson(request))); }
