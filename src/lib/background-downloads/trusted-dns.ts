import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isPrivateIP, isValidProxyUrl } from '@/lib/ssrf';

interface Address { address: string; family: number }
interface Answer { type: number; data: string; TTL?: number }
const cache = new Map<string, { expires: number; addresses: Address[] }>();

export function nonPublicAddress(address: string): boolean {
  if (isPrivateIP(address)) return true;
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    return octets[0] === 0 || octets[0] >= 224
      || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
      || (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19));
  }
  return !/^[23][0-9a-f]{0,3}:/i.test(address) || /^2001:0*2:/i.test(address);
}

export function trustedDnsConfigured(): boolean { return !!process.env.BACKGROUND_DOWNLOAD_DOH_URL?.trim(); }

/** Strict parser shared by providers following the Google/Cloudflare DNS JSON
 * schema (AliDNS represents its single Question as an object). */
export function parseDnsAnswer(body: unknown, hostname: string): { addresses: Address[]; ttl: number } {
  const data = body as { Status?: number; Question?: { name?: string; type?: number } | Array<{ name?: string; type?: number }>; Answer?: Answer[] };
  const question = Array.isArray(data?.Question) ? data.Question : [data?.Question];
  if (data?.Status !== 0 || !question.some((entry) => entry?.type === 1 && entry.name?.replace(/\.$/, '').toLowerCase() === hostname.toLowerCase())) throw new Error('可信 DNS 未返回匹配的有效答复');
  const answers = data.Answer?.filter((answer) => answer.type === 1) ?? [];
  if (!answers.length || answers.length > 128 || answers.some((answer) => isIP(answer.data) !== 4 || nonPublicAddress(answer.data))) throw new Error('可信 DNS 返回了私有或无效地址，已停止下载');
  return { addresses: answers.map((answer) => ({ address: answer.data, family: 4 })), ttl: Math.max(0, Math.min(60, ...answers.map((answer) => typeof answer.TTL === 'number' && Number.isFinite(answer.TTL) ? answer.TTL : 30))) };
}

export async function resolveTrustedDns(hostname: string, parentSignal?: AbortSignal): Promise<Address[]> {
  let endpoint: URL;
  try { endpoint = new URL(process.env.BACKGROUND_DOWNLOAD_DOH_URL!.trim()); }
  catch { throw new Error('可信 DNS 的 DoH 地址配置不正确'); }
  if (endpoint.protocol !== 'https:' || !isValidProxyUrl(endpoint.href) || endpoint.username || endpoint.password) throw new Error('可信 DNS 必须使用不含凭据的公网 HTTPS 地址');
  const bootstrap = (process.env.BACKGROUND_DOWNLOAD_DOH_BOOTSTRAP ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!bootstrap.length || bootstrap.length > 8 || bootstrap.some((address) => !isIP(address) || nonPublicAddress(address))) throw new Error('可信 DNS 必须配置有效的公网 bootstrap IP');
  const key = `${endpoint.href}\0${bootstrap.join(',')}\0${hostname}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.addresses;
  endpoint.searchParams.set('name', hostname); endpoint.searchParams.set('type', 'A');
  const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
  const lookup: LookupFunction = (_hostname, options, callback) => {
    const answers = bootstrap.map((address) => ({ address, family: isIP(address) }));
    const matches = typeof options.family === 'number' && options.family ? answers.filter((answer) => answer.family === options.family) : answers;
    if (!matches.length) { callback(new Error('可信 DNS bootstrap 地址类型不匹配'), ''); return; }
    if (options.all) callback(null, matches);
    else callback(null, matches[0].address, matches[0].family);
  };
  const body = await new Promise<unknown>((resolve, reject) => {
    const request = https.get(endpoint, { signal, lookup, agent: false, headers: { Accept: 'application/dns-json' } }, async (response) => {
      try {
        if (response.statusCode !== 200) { response.destroy(); throw new Error('可信 DNS 暂时不可用，请检查 DoH 配置和网络'); }
        const chunks: Buffer[] = []; let size = 0;
        for await (const value of response) {
          const chunk = Buffer.from(value); size += chunk.length;
          if (size > 64 * 1024) { response.destroy(); throw new Error('可信 DNS 答复超过大小限制'); }
          chunks.push(chunk);
        }
        resolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8')));
      } catch (error) { reject(error); }
    });
    request.once('error', reject);
  });
  const result = parseDnsAnswer(body, hostname);
  if (cache.size >= 200) cache.clear();
  if (result.ttl) cache.set(key, { expires: Date.now() + result.ttl * 1000, addresses: result.addresses });
  return result.addresses;
}
