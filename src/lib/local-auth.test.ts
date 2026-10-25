import { createRequire } from 'node:module';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { NodeNextRequest } from 'next/dist/server/base-http/node';
import { NextRequestAdapter } from 'next/dist/server/web/spec-extension/adapters/next-request';
import { addRequestMeta } from 'next/dist/server/request-meta';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLocalAuthBypass, clearRateLimit } from './auth';
import { guardRequest } from './api-guard';
import { GET as status } from '@/app/api/status/route';
import { GET as auth, POST as login } from '@/app/api/auth/route';
import { GET as library } from '@/app/api/library/route';

const require = createRequire(import.meta.url);
const { localWebServer } = require('../../scripts/macos/local-auth.cjs') as {
  localWebServer: (binary: string, env: Partial<NodeJS.ProcessEnv>, platform?: NodeJS.Platform) => { args: string[]; env: NodeJS.ProcessEnv };
};
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const BASE = 'http://127.0.0.1:8899';
const PASSWORD = 'local-auth-test-private';

function request(headers: Record<string, string> = {}, url = `${BASE}/api/library`) {
  return new Request(url, { headers: { host: '127.0.0.1:8899', ...headers } });
}

function enableLocal() {
  vi.stubEnv('LOCAL_AUTH_BYPASS', 'true');
  vi.stubEnv('LIBRETV_LOCAL_AUTH_BIND', '127.0.0.1:8899');
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  vi.stubEnv('PASSWORD', PASSWORD);
  vi.stubEnv('PUBLIC_ORIGIN', '');
  vi.stubEnv('LOCAL_AUTH_BYPASS', '');
  vi.stubEnv('LIBRETV_LOCAL_AUTH_BIND', '');
  vi.stubEnv('LOCAL_LIBRARY_DIR', '');
  clearRateLimit('unknown');
});

afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(process, 'platform', platform);
});

describe('explicit Mac loopback authentication', () => {
  it('opens status, session check and guarded library API without a cookie only in local mode', async () => {
    enableLocal();
    const local = request({ origin: BASE, 'sec-fetch-site': 'same-origin' });
    expect(guardRequest(local)).toBeNull();
    expect(await (await status(local)).json()).toMatchObject({ passwordRequired: true, verified: true, localAuthBypass: true });
    expect(await (await auth(local)).json()).toEqual({ success: true, verified: true });
    expect(await (await library(local)).json()).toEqual({ enabled: false, items: [] });
  });

  it('accepts real Next request adaptation and native local clients without Origin', async () => {
    enableLocal();
    const incoming = new IncomingMessage(new Socket());
    incoming.method = 'GET';
    incoming.url = '/api/library';
    incoming.headers = { host: 'localhost:8899', origin: 'http://localhost:8899' };
    const nodeRequest = new NodeNextRequest(incoming);
    addRequestMeta(nodeRequest, 'initURL', `${BASE}/api/library`);
    const adapted = NextRequestAdapter.fromNodeNextRequest(nodeRequest, new AbortController().signal);
    expect(isLocalAuthBypass(adapted)).toBe(true);
    expect(guardRequest(request())).toBeNull();
  });

  it('requires both an explicit opt-in and the launcher binding assertion', () => {
    expect(guardRequest(request())?.status).toBe(401);
    vi.stubEnv('LOCAL_AUTH_BYPASS', 'true');
    expect(guardRequest(request())?.status).toBe(401);
    vi.stubEnv('LIBRETV_LOCAL_AUTH_BIND', '0.0.0.0:8899');
    expect(guardRequest(request())?.status).toBe(401);
    vi.stubEnv('LIBRETV_LOCAL_AUTH_BIND', '127.0.0.1:8899');
    vi.stubEnv('LOCAL_AUTH_BYPASS', 'false');
    expect(guardRequest(request())?.status).toBe(401);
  });

  it('fails closed on non-Mac deployments, public origin configuration or absent PASSWORD', () => {
    enableLocal();
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    expect(guardRequest(request())?.status).toBe(401);
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    vi.stubEnv('PUBLIC_ORIGIN', 'https://media.example.test');
    expect(guardRequest(request())?.status).toBe(401);
    vi.stubEnv('PUBLIC_ORIGIN', '');
    vi.stubEnv('PASSWORD', '');
    expect(guardRequest(request())?.status).toBe(503);
  });

  it('rejects forged Host, URL, forwarded identity, different Origin and cross-site requests', () => {
    enableLocal();
    const hostile: Request[] = [
      request({ host: 'media.example.test', 'x-forwarded-host': '127.0.0.1:8899', 'x-forwarded-for': '127.0.0.1' }),
      request({ host: '127.0.0.1:8899' }, 'https://media.example.test/api/library'),
      request({}, 'http://0.0.0.0:8899/api/library'),
      request({}, 'http://127.0.0.1:9999/api/library'),
      request({ host: '127.0.0.1:8899@attacker.test' }),
      request({ origin: 'https://attacker.test' }),
      request({ origin: 'http://localhost:8899' }),
      request({ origin: 'null' }),
      request({ 'sec-fetch-site': 'cross-site' }),
      request({ 'sec-fetch-site': 'same-site' }),
      new Request(`${BASE}/api/library`),
    ];
    for (const attempt of hostile) {
      expect(isLocalAuthBypass(attempt)).toBe(false);
      expect(guardRequest(attempt)?.status).toBe(401);
    }
  });

  it('preserves password login, signed cookie validation and public defaults', async () => {
    const publicRequest = request({ host: 'media.example.test' }, 'https://media.example.test/api/library');
    expect(guardRequest(publicRequest)?.status).toBe(401);
    expect(await (await status(publicRequest)).json()).toMatchObject({ verified: false, localAuthBypass: false });
    const attempt = (password: string) => login(new Request('https://media.example.test/api/auth', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
    }));
    expect((await attempt('wrong')).status).toBe(401);
    const success = await attempt(PASSWORD);
    expect(success.status).toBe(200);
    const cookie = success.headers.get('set-cookie')!.split(';')[0];
    const authenticated = request({ cookie, host: 'media.example.test' }, 'https://media.example.test/api/library');
    expect(guardRequest(authenticated)).toBeNull();
    expect(await (await auth(authenticated)).json()).toEqual({ success: true, verified: true });
    expect(guardRequest(request({ cookie: 'ltv_session=%invalid' }))?.status).toBe(401);
  });
});

describe('Mac launcher local mode isolation', () => {
  it('ties the bypass assertion to the fixed loopback web command without mutating the parent', () => {
    const environment = { PASSWORD, LOCAL_AUTH_BYPASS: 'true' };
    const web = localWebServer('/repo/node_modules/next/dist/bin/next', environment, 'darwin');
    expect(web.args).toEqual(['/repo/node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', '8899']);
    expect(web.env.LIBRETV_LOCAL_AUTH_BIND).toBe('127.0.0.1:8899');
    expect(environment).toEqual({ PASSWORD, LOCAL_AUTH_BYPASS: 'true' });
  });

  it('removes inherited assertions when disabled or on a non-Mac platform and rejects public exposure', () => {
    expect(localWebServer('next', { LIBRETV_LOCAL_AUTH_BIND: '127.0.0.1:8899' }, 'darwin').env.LIBRETV_LOCAL_AUTH_BIND).toBeUndefined();
    expect(localWebServer('next', { LOCAL_AUTH_BYPASS: 'true', LIBRETV_LOCAL_AUTH_BIND: '127.0.0.1:8899' }, 'linux').env.LIBRETV_LOCAL_AUTH_BIND).toBeUndefined();
    expect(() => localWebServer('next', { LOCAL_AUTH_BYPASS: 'true', PUBLIC_ORIGIN: 'https://media.example.test' }, 'darwin')).toThrow('PUBLIC_ORIGIN');
  });
});
