import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupQuarkDownload, downloadQuarkMedia } from './download';
const mocks = vi.hoisted(() => ({ command: vi.fn(), records: vi.fn(), removeRecord: vi.fn(), account: 'a'.repeat(64) }));
vi.mock('./runtime', () => ({ quarkAccountKey: async () => mocks.account, runQuarkCommand: mocks.command, listQuarkDownloadRecords: mocks.records, deleteQuarkDownloadRecord: mocks.removeRecord }));
vi.mock('@/lib/background-downloads/media', async (original) => ({ ...await original<object>(), requireFreeSpace: vi.fn(async () => undefined) }));
let directory: string;
const reference = { shareUrl: 'https://pan.quark.cn/s/abc', fileId: 'source1', name: 'movie.mp4', size: 4, accountKey: 'a'.repeat(64) };
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libretv-quark-transfer-')); mocks.command.mockReset(); mocks.records.mockReset(); mocks.removeRecord.mockReset(); mocks.account = reference.accountKey; });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
function configure(pause?: AbortController, ids: { folderId?: string; savedFileId?: string } = {}) {
  let saved = false, record = false;
  const folderId = ids.folderId ?? 'folder1', savedFileId = ids.savedFileId ?? 'saved1';
  mocks.records.mockImplementation(async () => record ? [{ recordId: 'checkpoint1', fid: savedFileId, fileName: reference.name, fileSize: reference.size, state: 'paused' }] : []);
  mocks.removeRecord.mockResolvedValue(undefined);
  mocks.command.mockImplementation(async (args: string[], options?: { onProgress?: (current: number, total: number) => Promise<void> }) => {
    if (args[0] === 'create-folder') return { data: { fid: folderId } };
    if (args[0] === 'saveas') { expect(args).toContain('--fid-list'); expect(args).not.toContain('--save-all'); saved = true; return { data: {} }; }
    if (args[0] === 'browse') {
      const root = args[args.indexOf('--task-dir') + 1];
      const file = path.join(root, 'browse.jsonl');
      await fs.writeFile(file, saved ? JSON.stringify({ fid: savedFileId, filename: reference.name, size: reference.size, file_type: '1', category: 1 }) : '');
      return { data: { file_path: file } };
    }
    if (args[0] === 'download' && args[1] === 'list') return { data: {}, records: record ? [{ recordId: 'checkpoint1', fileName: reference.name, fileSize: reference.size, state: 'paused' }] : [] };
    if (args[0] === 'download' && args[1] === 'delete') { record = false; return { data: {} }; }
    if (args[0] === 'download') {
      await options?.onProgress?.(2, 4);
      if (pause && !pause.signal.aborted) { record = true; pause.abort(); throw new DOMException('paused', 'AbortError'); }
      const root = args[args.indexOf('--output-dir') + 1];
      const file = path.join(root, reference.name); await fs.writeFile(file, 'data');
      return { data: { filePath: file, fileName: reference.name } };
    }
    throw new Error('Unexpected command');
  });
}
describe('Quark transfer uses official checkpoints and a local-only import', () => {
  it('copies only the selected share file and validates the result before remux', async () => {
    configure(); const progress = vi.fn();
    const plan = await downloadQuarkMedia(reference, directory, new AbortController().signal, progress);
    expect(plan).toEqual({ version: 1, input: 'r000000.bin', resources: [] });
    expect(await fs.readFile(path.join(directory, plan.input), 'utf8')).toBe('data');
    expect(progress).toHaveBeenLastCalledWith(4, 4);
    expect(mocks.command.mock.calls.find(([args]) => args[0] === 'download' && args[1] === '--fid')?.[0]).toContain('saved1');
  });
  it('resumes its own paused checkpoint without copying the share again', async () => {
    const controller = new AbortController(); configure(controller);
    await expect(downloadQuarkMedia(reference, directory, controller.signal)).rejects.toThrow('paused');
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'quark-transfer.json'), 'utf8'));
    expect(saved.recordId).toBe('checkpoint1');
    await downloadQuarkMedia(reference, directory, new AbortController().signal);
    expect(mocks.command.mock.calls.filter(([args]) => args[0] === 'saveas')).toHaveLength(1);
    expect(mocks.command.mock.calls.find(([args]) => args[1] === 'resume')?.[0]).toContain('checkpoint1');
    await cleanupQuarkDownload(directory);
    expect(mocks.removeRecord).toHaveBeenLastCalledWith(reference.accountKey, 'checkpoint1', 'saved1');
  });
  it('preserves opaque SDK file and folder IDs through transfer, checkpoint recovery and cleanup', async () => {
    // The SDK returns saved FIDs with '~' and '|' instead of share-ID syntax.
    const savedFileId = `~${'Wq8eY9Zc2'.repeat(11)}|9P14Token`;
    const folderId = `~${'FolderSdkToken'.repeat(6)}|parent`;
    const controller = new AbortController();
    configure(controller, { savedFileId, folderId });
    await expect(downloadQuarkMedia(reference, directory, controller.signal)).rejects.toThrow('paused');
    const state = JSON.parse(await fs.readFile(path.join(directory, 'quark-transfer.json'), 'utf8'));
    expect(state).toMatchObject({ fileId: reference.fileId, savedFileId, folderId, recordId: 'checkpoint1' });
    const initial = mocks.command.mock.calls.find(([args]) => args[0] === 'download' && args[1] === '--fid')?.[0];
    expect(initial?.[initial.indexOf('--fid') + 1]).toBe(savedFileId);
    const save = mocks.command.mock.calls.find(([args]) => args[0] === 'saveas')?.[0];
    expect(save?.[save.indexOf('--fid-list') + 1]).toBe(reference.fileId);
    expect(save?.[save.indexOf('--to-pdir-fid') + 1]).toBe(folderId);
    await downloadQuarkMedia(reference, directory, new AbortController().signal);
    expect(mocks.command.mock.calls.filter(([args]) => args[0] === 'saveas')).toHaveLength(1);
    expect(mocks.command.mock.calls.find(([args]) => args[1] === 'resume')?.[0]).toContain('checkpoint1');
    expect(await fs.readFile(path.join(directory, 'r000000.bin'), 'utf8')).toBe('data');
    await cleanupQuarkDownload(directory);
    expect(mocks.removeRecord).toHaveBeenLastCalledWith(reference.accountKey, 'checkpoint1', savedFileId);
  });
  it('rejects empty, oversized and control-containing SDK folder IDs before saving files', async () => {
    for (const folderId of ['', 'x'.repeat(2049), 'bad\nfolder', 'bad\u0085folder']) {
      mocks.command.mockClear();
      configure(undefined, { folderId });
      await expect(downloadQuarkMedia(reference, directory, new AbortController().signal)).rejects.toThrow('无法建立夸克下载目录');
      expect(mocks.command.mock.calls.map(([args]) => args[0])).toEqual(['create-folder']);
    }
  });
  it('validates opaque saved IDs in disk state while retaining precise share and checkpoint ID rules', async () => {
    configure();
    const base = { version: 1, accountKey: reference.accountKey, fileId: reference.fileId, folderId: 'folder1', savedFileId: 'saved1' };
    for (const invalid of [{ savedFileId: '' }, { savedFileId: 'x'.repeat(2049) }, { savedFileId: 'bad\u0000file' }, { folderId: 'bad\nfolder' }, { fileId: '~opaque|share' }, { recordId: '~opaque|checkpoint' }]) {
      await fs.writeFile(path.join(directory, 'quark-transfer.json'), JSON.stringify({ ...base, ...invalid }));
      await expect(downloadQuarkMedia(reference, directory, new AbortController().signal)).rejects.toThrow('夸克断点记录不可用');
      expect(mocks.command).not.toHaveBeenCalled();
    }
  });
  it('rejects a changed account before touching any cloud files', async () => {
    configure(); mocks.account = 'b'.repeat(64);
    await expect(downloadQuarkMedia(reference, directory, new AbortController().signal)).rejects.toThrow('账号已变更');
    expect(mocks.command).not.toHaveBeenCalled();
  });
  it('rejects an out-of-directory success path instead of importing it', async () => {
    configure();
    const implementation = mocks.command.getMockImplementation()!;
    mocks.command.mockImplementation(async (args, options) => args[0] === 'download' && args[1] === '--fid' ? { data: { filePath: '/etc/passwd' } } : implementation(args, options));
    await expect(downloadQuarkMedia(reference, directory, new AbortController().signal)).rejects.toThrow('路径不安全');
    await expect(fs.stat(path.join(directory, 'r000000.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
