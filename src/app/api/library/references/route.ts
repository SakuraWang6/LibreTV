import { isLocalAuthBypass } from '@/lib/auth';
import { LibraryError, importExternalLibraryMedia, libraryRoute, readLibraryJson } from '@/lib/local-library/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request) {
  return libraryRoute(request, true, async () => {
    if (!isLocalAuthBypass(request)) throw new LibraryError('外部目录仅在 Mac 本机免登录模式下可用', 403);
    return importExternalLibraryMedia(await readLibraryJson(request), request);
  });
}
