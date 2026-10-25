import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, signSession } from '@/lib/auth';
import { GET, POST } from './route';
import { POST as share } from './share/route';
import { POST as enqueue } from './downloads/route';
const runtime = vi.hoisted(() => ({ enabled: true, status: vi.fn(), login: vi.fn(), complete: vi.fn(), share: vi.fn(), enqueue: vi.fn() }));
vi.mock('@/lib/quark/runtime', () => ({ quarkConfigured: () => runtime.enabled, quarkStatus: runtime.status, startQuarkLogin: runtime.login, completeQuarkLogin: runtime.complete }));
vi.mock('@/lib/quark/service', () => ({ listQuarkShare: runtime.share, enqueueQuarkFiles: runtime.enqueue }));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const request = (body?: unknown, extra: Record<string, string> = {}) => new Request('http://127.0.0.1:8899/api/quark', {
  method: body === undefined ? 'GET' : 'POST', headers: { host: '127.0.0.1:8899', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
beforeEach(() => {
  vi.clearAllMocks(); runtime.enabled = true;
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  vi.stubEnv('PASSWORD', 'quark-route-test'); vi.stubEnv('PUBLIC_ORIGIN', '');
  vi.stubEnv('LOCAL_AUTH_BYPASS', 'true'); vi.stubEnv('LIBRETV_LOCAL_AUTH_BIND', '127.0.0.1:8899');
  runtime.status.mockResolvedValue({ enabled: true, connected: false, pending: false });
  runtime.login.mockResolvedValue({ enabled: true, connected: false, pending: true });
  runtime.complete.mockResolvedValue({ enabled: true, connected: true, pending: false });
  runtime.share.mockResolvedValue({ entries: [], folderId: '0' }); runtime.enqueue.mockResolvedValue({ tasks: [] });
});
afterEach(() => { vi.unstubAllEnvs(); Object.defineProperty(process, 'platform', platform); });
describe('Quark stays on the private Mac listener', () => {
  it('allows only typed operations on the local deployment', async () => {
    expect(await (await GET(request())).json()).toEqual({ enabled: true, connected: false, pending: false });
    expect(await (await POST(request({ action: 'login' }))).json()).toMatchObject({ pending: true });
    expect(await (await POST(request({ action: 'complete-login', code: 'AAC-' + 'a'.repeat(32) }))).json()).toEqual({ enabled: true, connected: true, pending: false });
    expect((await POST(request({ action: 'run', command: 'anything' }))).status).toBe(400);
    expect((await share(request({ url: 'share' }))).status).toBe(200);
    expect((await enqueue(request({ url: 'share' }))).status).toBe(200);
  });
  it('rejects cross-site writes and forged Host headers', async () => {
    const variants: Record<string, string>[] = [{ origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' }, { host: 'attacker.example' }];
    for (const extra of variants) {
      for (const route of [POST, share, enqueue]) expect([401, 403]).toContain((await route(request({ action: 'login' }, extra))).status);
    }
    expect(runtime.login).not.toHaveBeenCalled(); expect(runtime.share).not.toHaveBeenCalled(); expect(runtime.enqueue).not.toHaveBeenCalled();
  });
  it('leaves public server and unconfigured deployments disabled even when signed in', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    const headers = { cookie: `${SESSION_COOKIE}=${signSession().token}` };
    expect(await (await GET(request(undefined, headers))).json()).toMatchObject({ enabled: false, connected: false });
    for (const route of [POST, share, enqueue]) expect((await route(request({ action: 'login' }, headers))).status).toBe(403);
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' }); runtime.enabled = false;
    expect(await (await GET(request())).json()).toMatchObject({ enabled: false });
  });
  it('does not reveal an internal exception through login', async () => {
    runtime.login.mockRejectedValue(new Error('/Users/private/accessToken=secret'));
    const response = await POST(request({ action: 'login' }));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('secret');
  });
});
