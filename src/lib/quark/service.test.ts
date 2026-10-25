import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueueQuarkFiles, listQuarkShare, metadataForQuarkFile, projectQuarkFile, quarkShareUrl } from './service';
const mocks = vi.hoisted(() => ({ root: '', account: 'a'.repeat(64), command: vi.fn(), enqueue: vi.fn() }));
vi.mock('./runtime', () => ({ quarkPrivateRoot: () => mocks.root, quarkAccountKey: async () => mocks.account, runQuarkCommand: mocks.command }));
vi.mock('@/lib/background-downloads/store', async (original) => ({ ...await original<object>(), enqueueQuarkDownloads: mocks.enqueue }));
let directory: string;
const share = 'https://pan.quark.cn/s/share123?pwd=1234';
const rawFile = { fid: 'file5', filename: 'Show.S01E05.mp4', size: 123, file_type: '1', category: 1, share_fid_token: 'secret', cookie: 'also-secret' };
const tv = { title: '示例电视剧', kind: 'tv' as const };
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libretv-quark-share-'));
  mocks.root = directory; mocks.account = 'a'.repeat(64); mocks.command.mockReset(); mocks.enqueue.mockReset();
  mocks.command.mockResolvedValue({ code: 0, data: { files: [rawFile], share_info: { title: '分享名' }, token_info: { stoken: 'secret' } } });
  mocks.enqueue.mockImplementation(async (inputs) => ({ tasks: inputs.map((input: { reference: { fileId: string }; metadata: unknown }) => ({ id: input.reference.fileId, metadata: input.metadata })) }));
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
describe('Quark share boundary', () => {
  it('accepts only official sharing URLs and keeps only a bounded extraction code', () => {
    expect(quarkShareUrl(share + '&untrusted=x#secret')).toBe(share);
    for (const url of ['http://pan.quark.cn/s/a', 'https://pan.quark.cn.evil.test/s/a', 'https://user:pw@pan.quark.cn/s/a', 'https://pan.quark.cn:8443/s/a', 'https://pan.quark.cn/list', 'https://127.0.0.1/s/a', 'https://pan.quark.cn/s/a?pwd=../../x']) expect(() => quarkShareUrl(url)).toThrow();
  });
  it('projects necessary file fields and never returns share credentials', async () => {
    const result = await listQuarkShare({ url: share });
    expect(result.entries).toEqual([{ id: 'file5', name: rawFile.filename, size: 123, isDirectory: false, downloadable: true }]);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(() => projectQuarkFile({ ...rawFile, filename: '../movie.mp4' })).toThrow();
    expect(projectQuarkFile({ ...rawFile, filename: 'not-video.zip' }).downloadable).toBe(false);
    expect(projectQuarkFile({ fid: 'folder1', filename: '第一季', size: 0, file_type: '0', category: 0 })).toMatchObject({ isDirectory: true, downloadable: false });
  });
  it('cannot enumerate an unrelated folder and requires a list in the same account', async () => {
    await expect(listQuarkShare({ url: share, folderId: 'private-folder' })).rejects.toThrow('根目录');
    await listQuarkShare({ url: share });
    mocks.account = 'b'.repeat(64);
    await expect(enqueueQuarkFiles({ url: share, fileIds: ['file5'], metadata: tv, idempotencyKey: 'request' })).rejects.toThrow('过期');
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('infers a single episode instead of inheriting validator default episode 1', async () => {
    await listQuarkShare({ url: share });
    await enqueueQuarkFiles({ url: share, fileIds: ['file5'], metadata: tv, idempotencyKey: 'request' });
    expect(mocks.enqueue.mock.calls[0][0][0]).toMatchObject({ metadata: { title: tv.title, seasonNumber: 1, episodeNumber: 5 }, reference: { accountKey: mocks.account, name: rawFile.filename } });
  });
  it('honors an explicitly edited episode and rejects ambiguous episodes before queue writes', async () => {
    await listQuarkShare({ url: share });
    await enqueueQuarkFiles({ url: share, fileIds: ['file5'], metadata: { ...tv, episodeNumber: 9 }, idempotencyKey: 'edited' });
    expect(mocks.enqueue.mock.calls[0][0][0].metadata.episodeNumber).toBe(9);
    mocks.enqueue.mockClear();
    await expect(enqueueQuarkFiles({ url: share, fileIds: ['file5', 'unknown'], metadata: tv, idempotencyKey: 'invalid' })).rejects.toThrow();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(() => metadataForQuarkFile(tv, { id: '1', name: '剧名.mp4', size: 1, isDirectory: false, downloadable: true }, 2)).toThrow('填写集数');
  });
  it('does not give every movie in a collection the same title or year', () => {
    const result = metadataForQuarkFile({ title: '教父1-3合集', year: '1972', kind: 'movie' }, { id: '1', name: '教父2.1974.1080p.mp4', size: 1, isDirectory: false, downloadable: true }, 3);
    expect(result).toMatchObject({ title: '教父2', year: '1974', kind: 'movie' });
    expect(result.coverUrl).toBeUndefined();
  });
});
