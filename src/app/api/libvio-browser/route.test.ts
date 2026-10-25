import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, signSession } from '@/lib/auth';
import { GET, POST } from './route';

const bridge = vi.hoisted(() => ({
  configured: true,
  status: vi.fn(),
  open: vi.fn(),
}));
vi.mock('@/lib/providers/libvio/browser-client', () => ({
  browserBridgeConfigured: () => bridge.configured,
  getLibvioBrowserStatus: bridge.status,
  openLibvioBrowser: bridge.open,
}));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
function local(headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1:8899/api/libvio-browser', {
    method: 'POST', headers: { host: '127.0.0.1:8899', ...headers },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  vi.stubEnv('PASSWORD', 'browser-route-test');
  vi.stubEnv('PUBLIC_ORIGIN', '');
  vi.stubEnv('LOCAL_AUTH_BYPASS', 'true');
  vi.stubEnv('LIBRETV_LOCAL_AUTH_BIND', '127.0.0.1:8899');
  bridge.configured = true;
  bridge.status.mockResolvedValue({ ok: true, browserOpen: true, verified: true, title: 'private title', url: 'private url' });
  bridge.open.mockResolvedValue({ ok: true, browserOpen: true, verified: false });
});
afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(process, 'platform', platform);
});

describe('Mac browser control boundary', () => {
  it('returns only public connection state to the local launcher', async () => {
    expect(await (await GET(local())).json()).toEqual({ enabled: true, connected: true, verified: true });
    expect(await (await POST(local())).json()).toEqual({ enabled: true, connected: true, verified: false });
    expect(bridge.open).toHaveBeenCalledTimes(1);
  });
  it('does not expose browser control on a signed-in public server', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    const request = new Request('https://example.com/api/libvio-browser', {
      method: 'POST', headers: { cookie: `${SESSION_COOKIE}=${signSession().token}` },
    });
    expect(await (await GET(request)).json()).toEqual({ enabled: false });
    expect((await POST(request)).status).toBe(403);
    expect(bridge.status).not.toHaveBeenCalled();
    expect(bridge.open).not.toHaveBeenCalled();
  });
  it('rejects cross-site browser opening even with a valid login cookie', async () => {
    const request = local({ origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site', cookie: `${SESSION_COOKIE}=${signSession().token}` });
    expect((await POST(request)).status).toBe(403);
    expect(bridge.open).not.toHaveBeenCalled();
  });
  it('leaves an unconfigured deployment disabled and reports recoverable bridge failure', async () => {
    bridge.configured = false;
    expect(await (await GET(local())).json()).toEqual({ enabled: false });
    expect((await POST(local())).status).toBe(403);
    bridge.configured = true;
    bridge.status.mockRejectedValue(new Error('private path'));
    bridge.open.mockRejectedValue(new Error('private path'));
    expect(await (await GET(local())).json()).toEqual({ enabled: true, connected: false, verified: false });
    const response = await POST(local());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private path');
  });
});
