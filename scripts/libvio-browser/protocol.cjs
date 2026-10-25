'use strict';

const HOSTS = new Set(['libvio.host', 'www.libvio.host', 'libvio.to', 'www.libvio.to', 'libviobd.com', 'www.libviobd.com']);
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 4096;
const MESSAGE = '请在 LibreTV 专用 Chrome 窗口完成 LIBVIO 网页验证后重试。';

function officialUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && HOSTS.has(url.hostname) && !url.username && !url.password && (!url.port || url.port === '443') ? url : null;
  } catch { return null; }
}

function allowedPage(raw) {
  const url = officialUrl(raw);
  return !!url && (url.pathname === '/' || url.pathname === '/search/-------------.html'
    || /^\/detail\/\d{1,18}\.html$/.test(url.pathname)
    || /^\/w\/\d{1,18}-\d{1,4}-\d{1,5}\.html$/.test(url.pathname));
}

/** No arbitrary URL, JavaScript, headers, browser command or filesystem input. */
function requestSpec(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid-request');
  const keys = Object.keys(input);
  const allowedKeys = ['op', 'host', 'term', 'id', 'line', 'episode'];
  if (keys.some((key) => !allowedKeys.includes(key))) throw new Error('invalid-request');
  if (input.op === 'status' && keys.length === 1) return { op: 'status' };
  const host = input.host || 'libvio.host';
  if (typeof host !== 'string' || !HOSTS.has(host)) throw new Error('invalid-host');
  const origin = `https://${host}`;
  if (input.op === 'open') return { op: 'open', url: `${origin}/` };
  if (input.op === 'search') {
    if (typeof input.term !== 'string' || !input.term.trim() || input.term.length > 100) throw new Error('invalid-term');
    const url = new URL('/search/-------------.html', origin);
    url.searchParams.set('wd', input.term.trim());
    return { op: 'page', url: url.href };
  }
  if (typeof input.id !== 'string' || !/^\d{1,18}$/.test(input.id)) throw new Error('invalid-id');
  if (input.op === 'detail') return { op: 'page', url: `${origin}/detail/${input.id}.html` };
  if (input.op === 'watch' && Number.isInteger(input.line) && input.line >= 1 && input.line <= 9999
    && Number.isInteger(input.episode) && input.episode >= 1 && input.episode <= 99999) {
    return { op: 'page', url: `${origin}/w/${input.id}-${input.line}-${input.episode}.html` };
  }
  throw new Error('invalid-operation');
}

function isChallenge(html) {
  return /browser verification required|<title[^>]*>\s*(?:正在验证|Just a moment)|cf-chl-|验证由浏览器完成一次工作量证明/i.test(html);
}

/** Self-contained DOM predicate, serialized by Playwright; never evaluates site JS. */
function watchDomReady() {
  const media = (raw) => {
    if (typeof raw !== 'string' || !raw || raw.length > 8192) return false;
    try {
      const url = new URL(raw, location.href);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        && !/^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1\]?$)/i.test(url.hostname)
        && !['pan.quark.cn', 'pan.xunlei.com', 'pan.baidu.com', 'drive.uc.cn', 'www.aliyundrive.com', 'www.alipan.com', '115.com', 'caiyun.139.com'].includes(url.hostname)
        && /\.(?:m3u8|mp4)$/i.test(url.pathname);
    } catch { return false; }
  };
  if ([...document.querySelectorAll('iframe')].some((frame) => {
    const src = frame.getAttribute('src');
    if (!src) return false;
    try {
      const url = new URL(src, location.href);
      return url.origin === location.origin && /^\/(?:vid\/plyr\/|static\/player\/)/.test(url.pathname);
    } catch { return false; }
  })) return true;
  if ([...document.querySelectorAll('video[src], source[src]')].some((node) => media(node.getAttribute('src')))) return true;
  return [...document.scripts].some((script) => {
    const raw = script.textContent || '';
    if (raw.length > 65536) return false;
    const match = raw.match(/^\s*(?:var|let|const)\s+player_\w+\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (!match) return false;
    try {
      const player = JSON.parse(match[1]);
      const encoding = String(player.encrypt ?? 0);
      if (!['0', '1', '2'].includes(encoding) || typeof player.url !== 'string') return false;
      let url = player.url;
      if (encoding === '2') url = atob(url);
      if (encoding === '1' || encoding === '2') url = decodeURIComponent(url);
      return media(url);
    } catch { return false; }
  });
}

function failureDiagnostic(error, rawUrl, phase) {
  const url = officialUrl(rawUrl);
  const message = typeof error?.message === 'string' ? error.message : '';
  const suppliedCode = typeof error?.code === 'string' && /^(?:ERR_[A-Z_0-9]+|HTTP_\d{3}|CHALLENGE_PAGE)$/.test(error.code) ? error.code : '';
  const code = suppliedCode || message.match(/net::(ERR_[A-Z_0-9]+)/)?.[1]
    || (/execution context was destroyed/i.test(message) ? 'CONTEXT_DESTROYED'
      : /interrupted by another navigation/i.test(message) ? 'NAVIGATION_INTERRUPTED'
        : /closed/i.test(message) ? 'TARGET_CLOSED'
          : /timeout/i.test(message) ? 'TIMEOUT' : 'BROWSER_READ_FAILED');
  return {
    phase: ['navigate', 'render', 'snapshot', 'validate', 'verification', 'resource'].includes(phase) ? phase : 'unknown',
    name: typeof error?.name === 'string' && /^[a-zA-Z][\w-]{0,63}$/.test(error.name) ? error.name : 'Error',
    code, url: url ? url.origin + url.pathname : '',
  };
}

module.exports = { HOSTS, MAX_HTML_BYTES, MAX_REQUEST_BYTES, MESSAGE, officialUrl, allowedPage, requestSpec, isChallenge, watchDomReady, failureDiagnostic };
