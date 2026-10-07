// Workers-native transport: no local Node process, proxy variables or filesystem.
// DNS checks are defense in depth: fetch resolves independently, so they do not
// provide DNS pinning. Do not connect this adapter to private network bindings.
const IPV4_BLOCKS = [[0,8],[0x0a000000,8],[0x64400000,10],[0x7f000000,8],[0xa9fe0000,16],[0xac100000,12],[0xc0000000,24],[0xc0000200,24],[0xc0a80000,16],[0xc6120000,15],[0xc6336400,24],[0xcb007100,24],[0xe0000000,4],[0xf0000000,4]];
function ipv4(address) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return null;
  const parts = address.split('.').map(Number);
  if (parts.some(part => part > 255)) return null;
  return parts.reduce((value, part) => (value * 256 + part) >>> 0, 0);
}
export function isPublicAddress(address) {
  const number = ipv4(address);
  if (number !== null) return !IPV4_BLOCKS.some(([base,bits]) => (number >>> (32-bits)) === (base >>> (32-bits)));
  if (!address.includes(':')) return false;
  try {
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1,-1);
    return /^[23][0-9a-f]{3}:/i.test(normalized) && !/^2001:(?:0:|:|db8:)/i.test(normalized) && !/^2002:/i.test(normalized);
  } catch { return false; }
}
export function publicURL(value) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只支持无凭据的 HTTP(S) 公开网址');
  if (!host.includes('.') && !host.includes(':') || /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host) || ((ipv4(host) !== null || host.includes(':')) && !isPublicAddress(host))) throw new Error('不能访问本机或内网地址');
  url.hash = '';
  return url;
}
async function boundedBody(response, maxBytes, signal) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const abort = () => reader.cancel('timeout').catch(() => {});
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error('请求超时');
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error('请求超时');
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error(`响应超过 ${maxBytes} 字节限制`); }
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(result);
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}
async function checkDNS(url, signal) {
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (ipv4(host) !== null || host.includes(':')) return;
  const answers = await Promise.all(['A','AAAA'].map(async type => {
    const endpoint = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`;
    const response = await fetch(endpoint, { headers: { Accept: 'application/dns-json' }, redirect: 'manual', signal });
    if (!response.ok) { await response.body?.cancel(); throw new Error('无法验证目标网址的 DNS'); }
    const result = JSON.parse(await boundedBody(response, 64_000, signal));
    if (result.Status !== 0) throw new Error('网址 DNS 解析失败');
    return (result.Answer || []).filter(item => item.type === 1 || item.type === 28).map(item => item.data);
  }));
  const addresses = answers.flat();
  if (!addresses.length || addresses.some(address => !isPublicAddress(address))) throw new Error('网址解析到了非公开地址');
}
export async function fetchText(value, { maxBytes = 2_000_000, timeoutMs = 20_000, headers = {} } = {}) {
  let url = publicURL(value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Math.max(timeoutMs, 1), 20_000));
  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has('Accept')) requestHeaders.set('Accept','application/rss+xml, application/atom+xml, application/json, text/html, */*');
  let retried = false;
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      await checkDNS(url, controller.signal);
      let response;
      while (true) {
        try { response = await fetch(url.href, { headers: requestHeaders, redirect: 'manual', signal: controller.signal }); }
        catch (error) { if (retried || controller.signal.aborted) throw error; retried = true; continue; }
        if (!retried && [408,502,503,504].includes(response.status)) { retried = true; await response.body?.cancel(); continue; }
        break;
      }
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('重定向缺少目标地址');
        const next = publicURL(new URL(location,url));
        if (next.origin !== url.origin) for (const name of ['Authorization','Cookie','Proxy-Authorization']) requestHeaders.delete(name);
        url = next;
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`HTTP ${response.status}: ${url.origin}${url.pathname}`), { statusCode: response.status }); }
      return await boundedBody(response, maxBytes, controller.signal);
    }
    throw new Error('重定向次数过多');
  } catch (error) { if (controller.signal.aborted) throw new Error('请求超时'); throw error; }
  finally { clearTimeout(timer); }
}
export async function fetchJSON(url, options) { return JSON.parse(await fetchText(url, options)); }
