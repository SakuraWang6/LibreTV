import { libraryRoute, listLibrary } from '@/lib/local-library/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return libraryRoute(request, false, () => listLibrary(request));
}
