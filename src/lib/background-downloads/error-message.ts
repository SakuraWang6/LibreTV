/** Keep network failures actionable without exposing signed source URLs or disk paths. */
export function downloadFailureMessage(error: unknown): string {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' || (error as NodeJS.ErrnoException).code === 'ETIMEDOUT')) {
    return '来源连接超时，请检查后台服务的网络或更换来源后重试';
  }
  const reason = error instanceof Error ? error.message : '后台下载失败';
  return /https?:\/\/|\/Users\/|\/home\//i.test(reason)
    ? '来源无法连接或返回了不支持的视频，请检查网络或更换来源后重试'
    : reason.slice(0, 240);
}
