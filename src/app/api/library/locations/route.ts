import { isLocalAuthBypass } from '@/lib/auth';
import { LibraryError, libraryRoute, readLibraryJson } from '@/lib/local-library/server';
import { listExternalLocations, registerExternalLocation, scanExternalLocation } from '@/lib/local-library/external-media';
import { chooseLibraryFolder } from '@/lib/local-library/folder-picker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function requireLocal(request: Request) {
  if (!isLocalAuthBypass(request)) throw new LibraryError('外部目录仅在 Mac 本机免登录模式下可用', 403);
}

export function GET(request: Request) {
  return libraryRoute(request, false, async () => {
    requireLocal(request);
    return { enabled: true, locations: await listExternalLocations() };
  });
}

export function POST(request: Request) {
  return libraryRoute(request, true, async () => {
    requireLocal(request);
    const body = await readLibraryJson(request) as { action?: unknown; path?: unknown; locationId?: unknown } | null;
    if (body?.action === 'add' && typeof body.path === 'string') return { location: await registerExternalLocation(body.path) };
    if (body?.action === 'scan' && typeof body.locationId === 'string') return scanExternalLocation(body.locationId);
    if (body?.action === 'choose') {
      const selected = await chooseLibraryFolder(request.signal);
      return selected ? { cancelled: false, location: await registerExternalLocation(selected) } : { cancelled: true };
    }
    throw new LibraryError('请选择有效的目录操作');
  });
}
