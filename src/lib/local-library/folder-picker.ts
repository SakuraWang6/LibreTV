import { execFile } from 'node:child_process';
import { LibraryError } from './server';

let choosing = false;

/** A fixed native dialog; callers cannot provide script text or shell arguments. */
export async function chooseLibraryFolder(signal?: AbortSignal): Promise<string | undefined> {
  if (process.platform !== 'darwin') throw new LibraryError('文件夹选择仅在 Mac 本机可用', 403);
  if (choosing) throw new LibraryError('已有文件夹选择窗口，请先完成选择', 409);
  choosing = true;
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      execFile('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "选择影片文件夹")'], {
        encoding: 'utf8', timeout: 120_000, maxBuffer: 8192, signal,
      }, (error, stdout, stderr) => {
        if (error) {
          if (signal?.aborted || /(?:^|\D)-128(?:\D|$)/.test(stderr || '')) { resolve(undefined); return; }
          reject(new LibraryError(error.killed ? '选择文件夹已超时，请重试' : '无法打开文件夹选择窗口，请重试', error.killed ? 408 : 503)); return;
        }
        const output = stdout.replace(/\r?\n$/, '');
        const selected = output.length > 1 ? output.replace(/\/$/, '') : output;
        if (!selected.startsWith('/') || selected.length > 4096 || /[\x00-\x1f\x7f]/.test(selected)) { reject(new LibraryError('所选文件夹路径无效')); return; }
        resolve(selected);
      });
    });
  } finally { choosing = false; }
}
