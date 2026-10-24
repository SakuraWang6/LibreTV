import { describe, expect, it } from 'vitest';
import { downloadFailureMessage } from './error-message';

describe('background download failure messages', () => {
  it('explains Node request/AbortSignal timeouts in Chinese', () => {
    for (const name of ['AbortError', 'TimeoutError']) {
      const error = new Error('The operation was aborted'); error.name = name;
      expect(downloadFailureMessage(error)).toBe('来源连接超时，请检查后台服务的网络或更换来源后重试');
    }
  });

  it('preserves specific supported-format and cancellation errors', () => {
    expect(downloadFailureMessage(new Error('下载已取消'))).toBe('下载已取消');
    expect(downloadFailureMessage(new Error('该视频超过单个任务的空间限制'))).toBe('该视频超过单个任务的空间限制');
  });

  it('does not publish signed source URLs or private filesystem paths', () => {
    for (const reason of ['request https://video.example/?token=private failed', 'ENOENT /Users/private/video.mp4', 'ENOENT /home/private/video.mp4']) {
      const result = downloadFailureMessage(new Error(reason));
      expect(result).not.toMatch(/token=|\/Users\/|\/home\//);
    }
  });
});
