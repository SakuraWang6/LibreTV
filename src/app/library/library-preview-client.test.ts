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
    await vi.advanceTimersByTimeAsync(750);
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
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    client.dispose();
  });

  it('continues a shared frame when a caller leaves, then reuses its cached result', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockImplementation(jpeg);
    vi.stubGlobal('fetch', fetcher);
    const client = createLibraryPreviewClient('movie');
    const controller = new AbortController();
    const pending = client.get(10, controller.signal);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    expect(await pending).toBeUndefined();
    await vi.advanceTimersByTimeAsync(750);
    expect(await client.get(10)).toBe('blob:preview-1');
    expect(fetcher).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it('waits beyond the old retry window for a busy extractor', async () => {
    let calls = 0;
    const fetcher = vi.fn().mockImplementation(() => ++calls <= 4
      ? new Response(null, { status: 503, headers: { 'retry-after': '1' } }) : jpeg());
    vi.stubGlobal('fetch', fetcher);
    const client = createLibraryPreviewClient('movie');
    const pending = client.get(20);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await pending).toBe('blob:preview-1');
    expect(fetcher).toHaveBeenCalledTimes(5);
    client.dispose();
  });

  it('serializes rapid hover changes and skips positions whose caller already moved away', async () => {
    let finishFirst: (response: Response) => void = () => {};
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finishFirst = resolve; })).mockImplementation(jpeg);
    vi.stubGlobal('fetch', fetcher);
    const client = createLibraryPreviewClient('movie');
    const firstSignal = new AbortController();
    const middleSignal = new AbortController();
    const first = client.get(0, firstSignal.signal);
    firstSignal.abort();
    const middle = client.get(50, middleSignal.signal);
    middleSignal.abort();
    const latest = client.get(100);
    expect(fetcher).toHaveBeenCalledTimes(1);
    finishFirst(jpeg());
    expect(await first).toBeUndefined();
    expect(await middle).toBeUndefined();
    expect(await latest).toBe('blob:preview-2');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/library/movie/preview?time=0', '/api/library/movie/preview?time=100']);
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
