import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachSeekPreviewPopover, createSeekPreviewClient, seekPreviewBucket, type SeekPreviewClient } from './seek-preview-client';

const hlsState = vi.hoisted(() => ({ supported: true, fatal: false, instances: [] as Array<{
  config: Record<string, unknown>; loadLevel: number; startLoad: ReturnType<typeof vi.fn>;
  stopLoad: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>;
}> }));
vi.mock('./hls-loader', () => ({ createHlsLoader: () => class {} }));
vi.mock('hls.js', () => {
  class FakeHls {
    static Events = { ERROR: 'error', MANIFEST_PARSED: 'parsed' };
    static isSupported = () => hlsState.supported;
    levels = [{ bitrate: 2_000_000 }, { bitrate: 150_000 }];
    loadLevel = -1;
    events = new Map<string, Set<(...args: unknown[]) => void>>();
    video?: { src: string; load(): void };
    source = '';
    constructor(public config: Record<string, unknown>) { hlsState.instances.push(this); }
    on(event: string, callback: (...args: unknown[]) => void) { const callbacks = this.events.get(event) ?? new Set(); callbacks.add(callback); this.events.set(event, callbacks); }
    off(event: string, callback: (...args: unknown[]) => void) { this.events.get(event)?.delete(callback); }
    attachMedia(video: { src: string; load(): void }) { this.video = video; }
    loadSource(url: string) {
      this.source = url;
      queueMicrotask(() => this.events.get(hlsState.fatal ? 'error' : 'parsed')?.forEach((callback) => callback('event', { fatal: true })));
    }
    startLoad = vi.fn(() => { this.video!.src = this.source; this.video!.load(); });
    stopLoad = vi.fn();
    destroy = vi.fn();
  }
  return { default: FakeHls };
});

let mode: 'normal' | 'stall' | 'cors' | 'error';
let doc: FakeDocument;
const videos: FakeVideo[] = [];
const clients: SeekPreviewClient[] = [];
const detachments: Array<() => void> = [];

class FakeVideo extends EventTarget {
  src = '';
  duration = 120;
  readyState = 0;
  seeking = false;
  videoWidth = 1920;
  videoHeight = 1080;
  crossOrigin = '';
  private time = 0;
  get currentTime() { return this.time; }
  set currentTime(time: number) {
    this.time = time; this.seeking = true;
    queueMicrotask(() => { this.readyState = 2; this.seeking = false; this.dispatchEvent(new Event('seeked')); });
  }
  load = vi.fn(() => {
    const source = this.src;
    if (!source || mode === 'stall') return;
    queueMicrotask(() => {
      if (source !== this.src) return;
      if (mode === 'error') this.dispatchEvent(new Event('error'));
      else { this.readyState = 1; this.dispatchEvent(new Event('loadedmetadata')); }
    });
  });
  pause = vi.fn();
  canPlayType = () => 'probably';
  removeAttribute(name: string) { if (name === 'src') { this.src = ''; this.readyState = 0; } }
}
class FakeElement extends EventTarget {
  style = { cssText: '', display: '', left: '', top: '' };
  children: FakeElement[] = [];
  src = '';
  alt = '';
  className = '';
  textContent = '';
  ownerDocument: FakeDocument;
  parent?: FakeElement;
  constructor() { super(); this.ownerDocument = doc; }
  setAttribute() {}
  querySelector() { return null; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  append(...children: FakeElement[]) { for (const child of children) this.appendChild(child); }
  appendChild(child: FakeElement) { this.children.push(child); child.parent = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  getBoundingClientRect() { return { width: 500, left: 0, top: 20 }; }
}
class FakeDocument extends EventTarget {
  visibilityState = 'visible';
  defaultView = new EventTarget();
  drawImage = vi.fn(() => { if (mode === 'cors') throw new DOMException('Tainted canvas', 'SecurityError'); });
  createElement(tag: string) {
    if (tag === 'video') { const video = new FakeVideo(); videos.push(video); return video; }
    if (tag === 'canvas') return { width: 0, height: 0,
      getContext: () => ({ fillStyle: '', fillRect() {}, drawImage: this.drawImage }),
      toBlob: (callback: (blob: Blob) => void) => queueMicrotask(() => callback(new Blob(['frame'], { type: 'image/jpeg' }))),
    };
    return new FakeElement();
  }
}

function client(url = 'https://cdn.example/film.mp4') {
  const result = createSeekPreviewClient({ url, blockAd: true }); clients.push(result); return result;
}
function hover(target: EventTarget, clientX: number, type = 'pointermove', pointerType = 'mouse') {
  const event = Object.assign(new Event(type, { cancelable: true }), { clientX, pointerType });
  target.dispatchEvent(event); return event;
}

beforeEach(() => {
  mode = 'normal'; videos.length = 0; hlsState.instances.length = 0;
  hlsState.supported = true; hlsState.fatal = false;
  doc = new FakeDocument();
  vi.stubGlobal('document', doc);
  let counter = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:preview-${++counter}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  detachments.splice(0).forEach((detach) => detach());
  clients.splice(0).forEach((item) => item.dispose());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('isolated seek preview frames', () => {
  it('uses a separate metadata-only CORS video, caches a five-second bucket and releases its source', async () => {
    const preview = client();
    const first = await preview.get(27.8);
    expect(first).toBe('blob:preview-1');
    expect(await preview.get(29.9)).toBe(first);
    expect(videos).toHaveLength(1);
    expect(videos[0].currentTime).toBe(25);
    expect(videos[0].crossOrigin).toBe('anonymous');
    expect(videos[0].src).toBe('');
    expect(videos[0].pause).toHaveBeenCalled();
    expect(doc.drawImage).toHaveBeenCalledWith(videos[0], 0, 0, 176, 99);
    expect(seekPreviewBucket(0)).toBe(0);
    preview.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
  });

  it('loads only the requested HLS position at the lowest bitrate with bounded buffers', async () => {
    const preview = client('https://cdn.example/film.m3u8');
    expect(await preview.get(47)).toBe('blob:preview-1');
    const hls = hlsState.instances[0];
    expect(hls.config).toMatchObject({ autoStartLoad: false, enableWorker: false, maxBufferLength: 1, maxMaxBufferLength: 2, backBufferLength: 0, maxBufferSize: 2 * 1024 * 1024 });
    expect(hls.loadLevel).toBe(1);
    expect(hls.startLoad).toHaveBeenCalledWith(45);
    expect(hls.stopLoad).toHaveBeenCalled(); expect(hls.destroy).toHaveBeenCalledOnce();
  });

  it('evicts old object URLs and revokes all remaining frames on disposal', async () => {
    const preview = client();
    for (let time = 0; time <= 60; time += 5) await preview.get(time);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    preview.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(13);
    expect(await preview.get(0)).toBeUndefined();
  });

  it('cancels a superseded seek and an explicitly aborted request without publishing stale frames', async () => {
    mode = 'stall';
    const preview = client();
    const first = preview.get(10);
    mode = 'normal';
    const second = preview.get(20);
    expect(await first).toBeUndefined(); expect(await second).toBe('blob:preview-1');
    mode = 'stall';
    const controller = new AbortController();
    const aborted = preview.get(30, controller.signal); controller.abort();
    expect(await aborted).toBeUndefined();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(videos.every((video) => video.src === '')).toBe(true);
  });

  it('times out stalled metadata and stops the outstanding media request', async () => {
    vi.useFakeTimers(); mode = 'stall';
    const pending = client().get(10);
    await vi.advanceTimersByTimeAsync(7000);
    expect(await pending).toBeUndefined();
    expect(videos[0].src).toBe('');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['cors', 'error', 'hls-fatal'] as const)('silently disables an undecodable source after %s', async (failure) => {
    mode = failure === 'hls-fatal' ? 'normal' : failure;
    hlsState.fatal = failure === 'hls-fatal';
    const preview = client(failure === 'hls-fatal' ? 'https://cdn.example/film.m3u8' : undefined);
    expect(await preview.get(10)).toBeUndefined();
    expect(await preview.get(20)).toBeUndefined();
    expect(videos).toHaveLength(1);
    expect(videos[0].src).toBe('');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe('ArtPlayer progress preview popover', () => {
  it('debounces hover, leaves seeking events untouched, and disposes old frames on a source switch', async () => {
    vi.useFakeTimers();
    const surface = new FakeElement(); const progress = new FakeElement();
    progress.getBoundingClientRect = () => ({ left: 50, width: 400, top: 300 });
    const handle = attachSeekPreviewPopover(surface as unknown as HTMLElement, progress as unknown as HTMLElement, () => 120, { url: 'https://cdn.example/a.mp4' });
    detachments.push(() => handle.dispose());
    expect(hover(progress, 250).defaultPrevented).toBe(false);
    expect(surface.children[0].children[1].textContent).toBe('01:00');
    await vi.advanceTimersByTimeAsync(179);
    expect(videos).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(videos).toHaveLength(1);
    expect(surface.children[0].children[0].src).toBe('blob:preview-1');
    handle.setSource({ url: 'https://cdn.example/b.mp4' });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    expect(surface.children[0].style.display).toBe('none');
    hover(progress, 250); hover(progress, 250, 'pointerleave');
    await vi.advanceTimersByTimeAsync(200);
    expect(videos).toHaveLength(1);
  });

  it('does not load a frame for touch movement or unknown duration', async () => {
    vi.useFakeTimers();
    const surface = new FakeElement(); const progress = new FakeElement();
    const handle = attachSeekPreviewPopover(surface as unknown as HTMLElement, progress as unknown as HTMLElement, () => Infinity, { url: 'https://cdn.example/a.mp4' });
    detachments.push(() => handle.dispose());
    hover(progress, 20, 'pointermove', 'touch'); hover(progress, 20);
    await vi.advanceTimersByTimeAsync(1000);
    expect(videos).toHaveLength(0);
    expect(surface.children[0].style.display).toBe('none');
  });
});
