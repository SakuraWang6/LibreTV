import dns from 'node:dns/promises';
import https from 'node:https';
import type http from 'node:http';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDownloadResource, publicAddresses } from './safe-fetch';
import * as trustedDns from './trusted-dns';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

function mockSocketResponses(open: (incoming: PassThrough, index: number) => void, statuses = [200]) {
  vi.stubEnv('BACKGROUND_DOWNLOAD_DOH_URL', '');
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.4.4', family: 4 }] as never);
  const calls: Array<{ url: string; options: https.RequestOptions }> = [];
  vi.spyOn(https, 'request').mockImplementation(((target: URL, options: https.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
    const index = calls.length;
    calls.push({ url: target.href, options });
    const incoming = Object.assign(new PassThrough(), {
      statusCode: statuses[index] ?? 200,
      headers: statuses[index] === 302 ? { location: 'https://final.example/movie.mp4' } : { 'content-type': 'video/mp4' },
    });
    const outgoing = Object.assign(new EventEmitter(), { end: () => queueMicrotask(() => {
      options.signal?.addEventListener('abort', () => {
        const reason = options.signal?.reason ?? new Error('aborted');
        incoming.destroy(reason); outgoing.emit('error', reason);
      }, { once: true });
      callback(incoming as unknown as http.IncomingMessage);
      open(incoming, index);
    }) });
    return outgoing as unknown as http.ClientRequest;
  }) as typeof https.request);
  return calls;
}

describe('download sockets and long-file idle deadlines', () => {
  it('uses media requests without source-specific headers on checked redirect hops and verifies TLS', async () => {
    const calls = mockSocketResponses((incoming, index) => { if (index === 1) incoming.end('movie'); }, [302, 200]);
    const { res, finalUrl } = await fetchDownloadResource('https://first.example/movie.mp4', { signal: new AbortController().signal, timeoutMs: 1000 });
    expect(await res.text()).toBe('movie');
    expect(finalUrl).toBe('https://final.example/movie.mp4');
    expect(calls.map((call) => call.url)).toEqual(['https://first.example/movie.mp4', 'https://final.example/movie.mp4']);
    for (const { options } of calls) {
      expect(options.headers).toEqual({ Accept: '*/*' });
      expect(options.lookup).toBeTypeOf('function');
      expect(options.agent).toBe(false);
      expect(options.rejectUnauthorized).not.toBe(false);
    }
  });

  it('leaves ordinary download requests without source headers', async () => {
    const calls = mockSocketResponses((incoming) => incoming.end('media'));
    const { res } = await fetchDownloadResource('https://cdn.example/segment.ts', { signal: new AbortController().signal, timeoutMs: 1000 });
    expect(await res.text()).toBe('media');
    expect(calls[0].options.headers).toEqual({ Accept: '*/*' });
  });

  it('allows ongoing data beyond the header deadline while resetting the body idle deadline', async () => {
    vi.useFakeTimers();
    const calls = mockSocketResponses((incoming) => {
      for (let index = 1; index <= 7; index++) setTimeout(() => incoming.write('x'), index * 10);
      setTimeout(() => incoming.end(), 80);
    });
    const pending = fetchDownloadResource('https://cdn.example/movie.mp4', { signal: new AbortController().signal, timeoutMs: 20, idleTimeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(0);
    const { res } = await pending;
    const body = res.text();
    await vi.advanceTimersByTimeAsync(100);
    expect(await body).toBe('xxxxxxx');
    expect(calls[0].options.signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a genuinely idle body and still responds immediately to worker cancellation', async () => {
    vi.useFakeTimers();
    mockSocketResponses((incoming) => incoming.write('start'));
    const first = fetchDownloadResource('https://cdn.example/movie.mp4', { signal: new AbortController().signal, timeoutMs: 20, idleTimeoutMs: 30 });
    await vi.advanceTimersByTimeAsync(0);
    const idle = (await first).res.text();
    const idleFailure = expect(idle).rejects.toThrow('没有返回数据');
    await vi.advanceTimersByTimeAsync(31);
    await idleFailure;
    const controller = new AbortController();
    const second = fetchDownloadResource('https://cdn.example/movie.mp4', { signal: controller.signal, timeoutMs: 20, idleTimeoutMs: 30 });
    await vi.advanceTimersByTimeAsync(0);
    const cancelled = (await second).res.text();
    const cancellation = expect(cancelled).rejects.toThrow('worker stopped');
    controller.abort(new Error('worker stopped'));
    await cancellation;
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('download socket DNS pinning', () => {
  it('rejects literal cloud metadata/private targets before a socket can be created', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data', 'http://127.0.0.1:8899/api/library', 'file:///etc/passwd', 'http://[::1]/']) {
      await expect(publicAddresses(new URL(url))).rejects.toThrow('拒绝');
    }
  });

  it('rechecks the exact DNS answer that will be pinned even if precheck saw a public address', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as never).mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }] as never);
    await expect(publicAddresses(new URL('https://rebind.example/video.mp4'))).rejects.toThrow('私有网络');
  });

  it('keeps only a vetted address set for the socket and refuses URL credentials', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.4.4', family: 4 }] as never);
    expect(await publicAddresses(new URL('https://cdn.example/video.ts'))).toEqual([{ address: '8.8.4.4', family: 4 }]);
    await expect(publicAddresses(new URL('https://secret:password@cdn.example/video.ts'))).rejects.toThrow('拒绝');
  });

  it('rejects multicast, alternate link-local IPv6 and the whole CGNAT block', async () => {
    for (const address of ['224.0.0.1', '255.255.255.255', '100.127.0.1', 'fe90::1']) {
      vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never)
        .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as never)
        .mockResolvedValueOnce([{ address, family: address.includes(':') ? 6 : 4 }] as never);
      await expect(publicAddresses(new URL('https://cdn.example/video'))).rejects.toThrow('私有网络');
      vi.restoreAllMocks();
    }
  });

  it('uses explicitly configured trusted DNS instead of OS fake-IP and still validates its returned addresses', async () => {
    vi.stubEnv('BACKGROUND_DOWNLOAD_DOH_URL', 'https://cloudflare-dns.com/dns-query');
    const system = vi.spyOn(dns, 'lookup').mockRejectedValue(new Error('OS DNS must never be used'));
    const trusted = vi.spyOn(trustedDns, 'resolveTrustedDns').mockResolvedValue([{ address: '151.101.2.132', family: 4 }]);
    expect(await publicAddresses(new URL('https://cdn.example/video.ts'))).toEqual([{ address: '151.101.2.132', family: 4 }]);
    expect(system).not.toHaveBeenCalled();
    trusted.mockResolvedValueOnce([{ address: '198.18.0.36', family: 4 }]);
    await expect(publicAddresses(new URL('https://cdn.example/video.ts'))).rejects.toThrow('私有网络');
    await expect(publicAddresses(new URL('http://169.254.169.254/'))).rejects.toThrow('拒绝');
  });
});
