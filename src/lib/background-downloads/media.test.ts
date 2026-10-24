import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMediaPlan, downloadResource, parseMediaPlaylist, remuxLocal } from './media';

const upstream = vi.hoisted(() => vi.fn());
vi.mock('./safe-fetch', () => ({ fetchDownloadResource: upstream }));
let directory: string;
const signal = () => new AbortController().signal;

beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libretv-background-media-')); upstream.mockReset(); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe('background media never passes upstream playlists to ffmpeg', () => {
  it('resolves every media/key/map URI itself and uses exact large sequence IVs', () => {
    const plan = parseMediaPlaylist('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:9007199254740993\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:5,\na.ts\n#EXTINF:5,\nb.ts\n#EXT-X-ENDLIST', 'https://cdn.example/video/list.m3u8');
    expect(plan.resources.map((entry) => entry.url)).toEqual(['https://cdn.example/video/key', 'https://cdn.example/video/a.ts', 'https://cdn.example/video/b.ts']);
    expect(plan.pieces?.map((piece) => piece.iv)).toEqual(['00000000000000000020000000000001', '00000000000000000020000000000002']);
    expect(plan.input).toBe('assembled.bin');
    expect(JSON.stringify(plan)).not.toContain('ffconcat');
  });

  it('rejects unsupported/live/DRM content and non-HTTP resource protocols', () => {
    for (const content of [
      '#EXTM3U\n#EXTINF:3,\na.ts',
      '#EXTM3U\nfile:///etc/passwd\n#EXT-X-ENDLIST',
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="file:///etc/passwd"\na.ts\n#EXT-X-ENDLIST',
      '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://example.com/key"\na.ts\n#EXT-X-ENDLIST',
      '#EXTM3U\n#EXT-X-BYTERANGE:50@0\na.ts\n#EXT-X-ENDLIST',
    ]) expect(() => parseMediaPlaylist(content, 'https://cdn.example/list.m3u8')).toThrow();
  });

  it('selects a self-contained variant and resolves relative URIs after redirects', async () => {
    upstream.mockResolvedValueOnce({ res: new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200\nhigh.m3u8', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }), finalUrl: 'https://final.example/path/master.m3u8' });
    upstream.mockResolvedValueOnce({ res: new Response('#EXTM3U\n#EXTINF:2,\nseg.ts\n#EXT-X-ENDLIST'), finalUrl: 'https://final.example/path/high.m3u8' });
    const plan = await createMediaPlan('https://first.example/master.m3u8', signal());
    expect(upstream.mock.calls[1][0]).toBe('https://final.example/path/high.m3u8');
    expect(plan.resources[0].url).toBe('https://final.example/path/seg.ts');
    for (const call of upstream.mock.calls) expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('commits whole resources, reuses completed disk fragments and rejects invalid AES keys', async () => {
    upstream.mockResolvedValue({ res: new Response(Buffer.from('whole-segment')), finalUrl: 'https://example.com/a.ts' });
    const resource = { url: 'https://example.com/a.ts', name: 'r000000.bin' };
    expect(await downloadResource(resource, directory, signal(), 0)).toBe(13);
    expect(await downloadResource(resource, directory, signal(), 0)).toBe(13);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(directory)).toEqual(['r000000.bin']);
    upstream.mockImplementation(async () => ({ res: new Response('invalid'), finalUrl: resource.url }));
    await expect(downloadResource({ ...resource, name: 'r000001.key', key: true }, directory, signal(), 13)).rejects.toThrow('无效');
    expect(await fs.readdir(directory)).toEqual(['r000000.bin']);
  });

  it('decrypts AES locally, then rejects a disguised playlist before starting ffmpeg', async () => {
    const key = Buffer.alloc(16, 7);
    const iv = Buffer.alloc(16);
    const plaintext = Buffer.from('#EXTM3U\nfile:///etc/passwd\n#EXT-X-ENDLIST');
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    await fs.writeFile(path.join(directory, 'r000000.key'), key);
    await fs.writeFile(path.join(directory, 'r000001.bin'), Buffer.concat([cipher.update(plaintext), cipher.final()]));
    await expect(remuxLocal({ version: 1, input: 'assembled.bin', resources: [], pieces: [{ name: 'r000001.bin', keyName: 'r000000.key', iv: iv.toString('hex') }] }, directory, signal())).rejects.toThrow('不是支持');
    expect(await fs.readFile(path.join(directory, 'assembled.bin'))).toEqual(plaintext);
    await expect(fs.stat(path.join(directory, 'result.mp4'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
