import { libraryRoute } from '@/lib/local-library/server';
import { getSyncStatus } from '@/lib/library-sync/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) { return libraryRoute(request, false, getSyncStatus); }
