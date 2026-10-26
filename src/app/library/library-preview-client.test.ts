import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLibraryPreviewClient } from './library-preview-client';

const jpeg = () => new Response(new Blob(['jpeg'], { type: 'image/jpeg' }), { headers: { 'content-type': 'image/jpeg' } });

describe('library thumbnail requests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    let sequence = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:preview-${++sequence}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('shares a five-second bucket and releases its URL on disposal', async () => {
    const fetcher = vi.fn().mockImplementation(jpeg);
    vi.stubGlobal('fetch', fetcher);
    const client = createLibraryPreviewClient('movie');
    expect(await client.get(17.4)).toBe('blob:preview-1');
    expect(await client.get(19.9)).toBe('blob:preview-1');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('/api/library/movie/preview?time=15', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
    client.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  });

  it('retries a busy extractor while the same hover remains active', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockImplementation(jpeg);
    vi.stubGlobal('fetch', fetcher);
    const client = createLibraryPreviewClient('movie');
    const pending = client.get(10);
    await vi.advanceTimersByTimeAsync(650);
    expect(await pending).toBe('blob:preview-1');
    expect(fetcher).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it('bounds busy retries and leaves a failed frame without a Blob', async () => {
    const fetcher = vi.fn().mockImplementation(() => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const client = createLibraryPreviewClient('movie');
    const pending = client.get(10);
    await vi.runAllTimersAsync();
    expect(await pending).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    client.dispose();
  });

  it('cancels a pending retry when the hover moves away', async () => {
    const fetcher = vi.fn().mockImplementation(() => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const client = createLibraryPreviewClient('movie');
    const controller = new AbortController();
    const pending = client.get(10, controller.signal);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.runAllTimersAsync();
    expect(await pending).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it('revokes evicted frames rather than retaining every inspected timestamp', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(jpeg));
    const client = createLibraryPreviewClient('movie', 2);
    await client.get(0); await client.get(5); await client.get(0); await client.get(10);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-2');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:preview-1');
    client.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  });

  it('aborts in-flight work on disposal and rejects invalid frame responses', async () => {
    const fetcher = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
    vi.stubGlobal('fetch', fetcher);
    const client = createLibraryPreviewClient('movie');
    const pending = client.get(10);
    client.dispose();
    expect(await pending).toBeUndefined();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(await client.get(15)).toBeUndefined();
    const invalid = createLibraryPreviewClient('movie');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { headers: { 'content-type': 'text/html' } })));
    expect(await invalid.get(0)).toBeUndefined();
    expect(await invalid.get(Number.NaN)).toBeUndefined();
    invalid.dispose();
  });
});
