import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { checkUpstreamAllowed, isValidProxyUrl } from '@/lib/ssrf';
import { nonPublicAddress, resolveTrustedDns, trustedDnsConfigured } from './trusted-dns';
import { mediaContextHeaders, type MediaContext } from '@/lib/media-context';

/** DNS results are pinned into the socket lookup, closing the precheck/fetch
 * re-resolution gap. Every redirect gets a fresh check and a fresh pinned set. */
export async function publicAddresses(url: URL, signal?: AbortSignal): Promise<Array<{ address: string; family: number }>> {
  const trusted = trustedDnsConfigured();
  const allowed = trusted ? { ok: isValidProxyUrl(url.href) } : await checkUpstreamAllowed(url.href);
  if (!allowed.ok || url.username || url.password) throw new Error('视频资源地址被安全检查拒绝');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  const answers = family ? [{ address: hostname, family }] : trusted ? await resolveTrustedDns(hostname, signal) : await dns.lookup(hostname, { all: true });
  if (!answers.length || answers.some((entry) => nonPublicAddress(entry.address))) throw new Error('视频资源解析到了私有网络，已停止下载');
  return answers.sort((a, b) => a.family - b.family);
}

export async function fetchDownloadResource(url: string, options: { signal: AbortSignal; timeoutMs: number; mediaContext?: MediaContext; idleTimeoutMs?: number }): Promise<{ res: Response; finalUrl: string }> {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, options.idleTimeoutMs ? controller.signal : AbortSignal.timeout(options.timeoutMs)]);
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    signal.throwIfAborted();
    const headerTimer = options.idleTimeoutMs ? setTimeout(() => controller.abort(new Error('视频来源连接超时')), options.timeoutMs) : undefined;
    let incoming: http.IncomingMessage;
    try {
      const target = new URL(current);
      const answers = await publicAddresses(target, signal);
      signal.throwIfAborted();
      const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
        const family = typeof lookupOptions.family === 'number' ? lookupOptions.family : undefined;
        const matching = family ? answers.filter((entry) => entry.family === family) : answers;
        if (!matching.length) { callback(new Error('没有可连接的公网地址'), ''); return; }
        if (lookupOptions.all) callback(null, matching);
        else callback(null, matching[0].address, matching[0].family);
      };
      incoming = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const transport = target.protocol === 'https:' ? https : http;
        const request = transport.request(target, { method: 'GET', signal, lookup, agent: false, headers: { Accept: '*/*', ...mediaContextHeaders(options.mediaContext) } }, resolve);
        request.once('error', reject);
        request.end();
      });
    } finally { if (headerTimer) clearTimeout(headerTimer); }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const status = incoming.statusCode ?? 502;
    if ([301, 302, 303, 307, 308].includes(status) && headers.has('location')) {
      incoming.destroy();
      if (hop === 5) throw new Error('视频资源重定向次数过多');
      current = new URL(headers.get('location')!, current).href;
      continue;
    }
    const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
    if (body === null) incoming.destroy();
    if (body && options.idleTimeoutMs && !incoming.destroyed && !incoming.readableEnded) {
      let idleTimer: ReturnType<typeof setTimeout>;
      const clearIdle = () => clearTimeout(idleTimer);
      const resetIdle = () => {
        clearIdle();
        idleTimer = setTimeout(() => controller.abort(new Error('视频来源长时间没有返回数据，请检查网络后重试')), options.idleTimeoutMs);
      };
      incoming.on('data', resetIdle);
      for (const event of ['end', 'close', 'error']) incoming.once(event, clearIdle);
      resetIdle();
    }
    return { res: new Response(body, { status, headers }), finalUrl: current };
  }
  throw new Error('视频资源请求失败');
}
