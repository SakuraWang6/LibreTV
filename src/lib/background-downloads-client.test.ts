import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackgroundDownload } from './background-downloads-client';

afterEach(() => { vi.unstubAllGlobals(); });

describe('background download public source context', () => {
  it('submits the original media URL and durable context separately, without browser headers', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ task: { id: 'a'.repeat(32) } })));
    vi.stubGlobal('fetch', fetcher);
    const url = 'https://cdn.example/movie.mp4';
    await createBackgroundDownload(url, { title: 'Movie', kind: 'movie' }, 'same-request', 'libvio');
    const [endpoint, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe('/api/downloads');
    expect(JSON.parse(String(init.body))).toEqual({ url, metadata: { title: 'Movie', kind: 'movie' }, idempotencyKey: 'same-request', mediaContext: 'libvio' });
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  });
});
