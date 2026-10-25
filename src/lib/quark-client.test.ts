import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeQuarkLogin, createQuarkDownloads, isQuarkShareUrl, listQuarkShare, startQuarkLogin, validateQuarkAuthUrl } from './quark-client';
import { changeBackgroundDownload } from './background-downloads-client';

afterEach(() => vi.unstubAllGlobals());

describe('Quark client boundaries', () => {
  it('recognizes only official HTTPS share URLs, including extraction-code queries', () => {
    expect(isQuarkShareUrl('https://pan.quark.cn/s/abc123?pwd=1234')).toBe(true);
    for (const url of ['http://pan.quark.cn/s/abc123', 'https://pan.quark.cn.evil.test/s/abc123', 'https://pan.quark.cn@evil.test/s/abc123', 'https://pan.quark.cn:9443/s/abc123', 'https://pan.quark.cn/list', 'javascript:alert(1)']) expect(isQuarkShareUrl(url)).toBe(false);
  });

  it('rejects browser authorization destinations outside official hosts', async () => {
    expect(validateQuarkAuthUrl('https://pan.quark.cn/authorize?state=public-state')).toContain('https://pan.quark.cn/');
    for (const url of ['https://pan.quark.cn.evil.test/authorize', 'https://pan.quark.cn@evil.test/authorize', 'http://pan.quark.cn/authorize', 'javascript:alert(1)', '/authorize', 'https://evil.test']) expect(() => validateQuarkAuthUrl(url)).toThrow('登录地址无效');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ authUrl: 'https://evil.test/oauth' })));
    await expect(startQuarkLogin()).rejects.toThrow('登录地址无效');
  });

  it('lists one selected folder and never sends credentials or a whole-drive selector', async () => {
    const fetcher = vi.fn(async () => Response.json({ entries: [], folderId: 'selected-folder' }));
    vi.stubGlobal('fetch', fetcher);
    await listQuarkShare('https://pan.quark.cn/s/abc123', 'selected-folder');
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/quark/share');
    expect(JSON.parse(String(init.body))).toEqual({ url: 'https://pan.quark.cn/s/abc123', folderId: 'selected-folder' });
    expect(init.credentials).toBe('same-origin');
  });

  it('accepts the official authorization-code format only and never sends an invalid code', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    for (const code of ['', 'AAC-not-a-code', 'AAC-' + '0'.repeat(31), 'AAC-' + 'g'.repeat(32), 'https://pan.quark.cn/authorize']) await expect(completeQuarkLogin(code)).rejects.toThrow('授权码格式不正确');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends an authorization code only in the POST body and returns public connection status', async () => {
    const fetcher = vi.fn(async () => Response.json({ enabled: true, connected: true, accountLabel: 'Connected', internalSecret: 'must-not-be-returned' }));
    vi.stubGlobal('fetch', fetcher);
    const code = 'AAC-' + '0'.repeat(32);
    const status = await completeQuarkLogin(` ${code} `);
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/quark');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(String(init.body))).toEqual({ action: 'complete-login', code });
    expect(status).toEqual({ enabled: true, connected: true, accountLabel: 'Connected' });
  });

  it('queues only unique selected files and clears shared episode identity for a season batch', async () => {
    const fetcher = vi.fn(async () => Response.json({ tasks: [{ id: 'task-one' }, { id: 'task-two' }] }));
    vi.stubGlobal('fetch', fetcher);
    await createQuarkDownloads('https://pan.quark.cn/s/abc123', ['episode-1', 'episode-2', 'episode-1'], {
      title: 'Test Series', kind: 'tv', seasonNumber: 2, episodeNumber: 9, episodeTitle: '第九集', coverUrl: 'https://covers.example/poster.jpg',
    }, 'same-submission');
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/quark/downloads');
    expect(JSON.parse(String(init.body))).toEqual({
      url: 'https://pan.quark.cn/s/abc123', fileIds: ['episode-1', 'episode-2'], idempotencyKey: 'same-submission',
      metadata: { title: 'Test Series', kind: 'tv', seasonNumber: 2, coverUrl: 'https://covers.example/poster.jpg' },
    });
  });

  it('keeps an explicitly chosen single episode and removes episode fields for movies', async () => {
    const fetcher = vi.fn(async () => Response.json({ tasks: [{ id: 'task-one' }] }));
    vi.stubGlobal('fetch', fetcher);
    await createQuarkDownloads('https://pan.quark.cn/s/abc123', ['episode-1'], { title: 'Series', kind: 'tv', seasonNumber: 1, episodeNumber: 3 }, 'single');
    expect(JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body)).metadata.episodeNumber).toBe(3);
    await createQuarkDownloads('https://pan.quark.cn/s/abc123', ['movie-1'], { title: 'Film', kind: 'movie', seasonNumber: 1, episodeNumber: 3 }, 'movie');
    expect(JSON.parse(String((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body)).metadata).toEqual({ title: 'Film', kind: 'movie' });
  });

  it('does not report a successful enqueue when the server returns an empty task list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tasks: [] })));
    await expect(createQuarkDownloads('https://pan.quark.cn/s/abc123', ['video-1'], { title: 'Film', kind: 'movie' }, 'empty')).rejects.toThrow('未确认任务已创建');
  });

  it.each(['pause', 'resume'] as const)('uses the durable %s endpoint', async (action) => {
    const fetcher = vi.fn(async () => Response.json({ task: { id: 'task-one' } }));
    vi.stubGlobal('fetch', fetcher);
    await changeBackgroundDownload('task-one', action);
    expect(fetcher).toHaveBeenCalledWith(`/api/downloads/task-one/${action}`, expect.objectContaining({ method: 'POST' }));
  });
});
