import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(ip, prefix, 'ipv4');
for (const [ip, prefix] of [['2001::',32],['2001:db8::',32],['2002::',16]]) blocked.addSubnet(ip, prefix, 'ipv6');

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  // Only globally routed IPv6; excludes loopback, local, mapped IPv4 and multicast.
  if (family === 6) return /^[23][0-9a-f]{3}:/i.test(address) && !blocked.check(address, 'ipv6');
  return false;
}

export function publicURL(value) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('只支持无凭据的 HTTP(S) 公开网址');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || (isIP(hostname) && !isPublicAddress(hostname))) throw new Error('不能访问本机或内网地址');
  url.hash = '';
  return url;
}

async function requestText(url, { maxBytes, headers, signal }) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await Promise.race([
    lookup(hostname, { all: true }),
    new Promise((_, reject) => {
      if (signal.aborted) return reject(new Error('请求超时'));
      signal.addEventListener('abort', () => reject(new Error('请求超时')), { once: true });
    }),
  ]);
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('网址解析到了非公开地址');
  const address = addresses.find(item => item.family === 4) || addresses[0];
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get(url, {
      signal,
      agent: false,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 250,
      // Pin the checked DNS result to prevent DNS rebinding. Never use proxy env vars.
      lookup: (_host, options, callback) => options.all ? callback(null, addresses) : callback(null, address.address, address.family),
      headers: { 'User-Agent': 'BanyanResearch/0.1 (+local personal research)', Accept: 'application/rss+xml, application/atom+xml, application/json, text/html, */*', 'Accept-Encoding': 'identity', ...headers },
    }, response => {
      if ([301,302,303,307,308].includes(response.statusCode)) {
        response.resume();
        return resolve({ redirect: response.headers.location });
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        return reject(Object.assign(new Error(`HTTP ${response.statusCode}: ${url.origin}${url.pathname}`), { statusCode: response.statusCode }));
      }
      const encoding = (response.headers['content-encoding'] || '').toLowerCase();
      const decompress = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
      if (encoding && encoding !== 'identity' && !decompress) {
        response.destroy();
        return reject(new Error(`不支持的内容编码: ${encoding}`));
      }
      const stream = decompress ? response.pipe(decompress) : response;
      const chunks = [];
      let size = 0;
      stream.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(new Error(`响应超过 ${maxBytes} 字节限制`));
          request.destroy(); response.destroy(); stream.destroy();
        } else chunks.push(chunk);
      });
      stream.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', reject);
      response.on('error', reject);
    });
    request.on('error', error => reject(signal.aborted ? new Error('请求超时') : error));
  });
}

export async function fetchText(value, { maxBytes = 2_000_000, timeoutMs = 20_000, headers = {} } = {}) {
  let url = publicURL(value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let requestHeaders = { ...headers };
  let retried = false;
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      let result;
      try {
        result = await requestText(url, { maxBytes, headers: requestHeaders, signal: controller.signal });
      } catch (error) {
        const transient = ['ECONNRESET','ETIMEDOUT','EAI_AGAIN','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH'].includes(error.code)
          || [408,502,503,504].includes(error.statusCode)
          || error.errors?.some(item => ['ECONNRESET','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH'].includes(item.code));
        if (retried || controller.signal.aborted || !transient) throw error;
        // One retry for this complete GET operation, within the original timeout budget.
        // Authorization errors, rate limits, DNS safety failures and oversized bodies never retry.
        retried = true;
        result = await requestText(url, { maxBytes, headers: requestHeaders, signal: controller.signal });
      }
      if ('text' in result) return result.text;
      if (!result.redirect) throw new Error('重定向缺少目标地址');
      const next = publicURL(new URL(result.redirect, url));
      if (next.origin !== url.origin) requestHeaders = Object.fromEntries(Object.entries(requestHeaders).filter(([key]) => !['authorization','cookie','proxy-authorization'].includes(key.toLowerCase())));
      url = next;
    }
    throw new Error('重定向次数过多');
  } finally { clearTimeout(timer); }
}

export async function fetchJSON(url, options) { return JSON.parse(await fetchText(url, options)); }
