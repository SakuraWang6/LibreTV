// Only the library sync child uses this opt-in proxy. Other processes keep
// their own transports, including the download worker's DNS-pinned requests.
function syncWorkerEnvironment(environment, supported = process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
  const result = { ...environment };
  const configured = environment.LIBRARY_SERVER_PROXY?.trim();
  if (!configured) return result;
  let proxy;
  try { proxy = new URL(configured); } catch { /* Return one non-sensitive error below. */ }
  if (!proxy || !['http:', 'https:'].includes(proxy.protocol) || proxy.pathname !== '/' || proxy.search || proxy.hash) {
    throw new Error('LIBRARY_SERVER_PROXY 需要填写可信 HTTP / HTTPS 代理地址，不包含路径。');
  }
  if (!supported) throw new Error('同步代理需要 Node.js 22.21 或 24.5 及更新版本。');
  // Lower-case variables take precedence in some Node versions. An explicit
  // library setting must not accidentally inherit a different proxy/bypass.
  for (const key of ['http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'ALL_PROXY']) delete result[key];
  result.HTTP_PROXY = proxy.href;
  result.HTTPS_PROXY = proxy.href;
  result.NO_PROXY = 'localhost,127.0.0.1,::1,[::1]';
  result.NODE_USE_ENV_PROXY = '1';
  return result;
}

module.exports = { syncWorkerEnvironment };
