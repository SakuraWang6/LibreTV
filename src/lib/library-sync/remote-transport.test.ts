import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { curlRangeResponse } from './curl';
import { remoteCatalog, remoteRequest } from './remote';
import type { SyncConfig } from './storage';

vi.mock('./curl', () => ({ curlRangeResponse: vi.fn() }));
let config: SyncConfig;
let login: number;
let sequence = 0;

beforeEach(() => {
  login = 0;
  config = { origin: 'https://native-library.example.test', password: `private-${++sequence}`, libraryDirectory: '/tmp/unused-library', mediaTransport: 'curl' };
  vi.mocked(curlRangeResponse).mockReset();
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/auth') return Response.json({ success: true }, { headers: { 'Set-Cookie': `ltv_session=session-${++login}; HttpOnly; Path=/` } });
    if (url.pathname === '/api/library') return Response.json({ enabled: true, items: [] });
    return new Response('native-fetch');
  }));
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('library media transport selection', () => {
  it('keeps catalog traffic on fetch and preserves cookie renewal for native media ranges', async () => {
    await expect(remoteCatalog(config)).resolves.toEqual([]);
    expect(curlRangeResponse).not.toHaveBeenCalled();
    vi.mocked(curlRangeResponse).mockResolvedValueOnce(Response.json({ error: 'expired' }, { status: 401 }))
      .mockResolvedValueOnce(new Response('012345', { status: 206, headers: { 'Content-Range': 'bytes 0-5/6' } }));
    const response = await remoteRequest(config, `/api/library/${'a'.repeat(32)}/media`, { headers: { Range: 'bytes=0-5' } });
    expect(await response.text()).toBe('012345');
    expect(login).toBe(2);
    const calls = vi.mocked(curlRangeResponse).mock.calls;
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0][1]).get('cookie')).toBe('ltv_session=session-1');
    expect(new Headers(calls[1][1]).get('cookie')).toBe('ltv_session=session-2');
    expect(new Headers(calls[1][1]).get('range')).toBe('bytes=0-5');
  });

  it('retains the original media client when native transport is not selected', async () => {
    config.mediaTransport = 'fetch';
    const response = await remoteRequest(config, `/api/library/${'b'.repeat(32)}/media`, { headers: { Range: 'bytes=0-5' } });
    expect(await response.text()).toBe('native-fetch');
    expect(curlRangeResponse).not.toHaveBeenCalled();
  });
});
