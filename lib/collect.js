import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { fetchText, publicURL } from '#network';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, processEntities: false, parseTagValue: false, trimValues: true });
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const value = node => typeof node === 'object' && node ? Object.entries(node).filter(([key]) => !key.startsWith('@_')).map(([, child]) => array(child).map(value).join(' ')).join(' ') : String(node || '');
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(text = '') {
  return String(text).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, name) => {
    if (name[0] !== '#') return entities[name.toLowerCase()] || all;
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

export function plainText(html = '') {
  return decodeEntities(decodeEntities(html).replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function attrs(tag) {
  const result = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) result[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4]);
  return result;
}

function absoluteURL(href, base) {
  if (!href || !String(href).trim()) return '';
  try { return publicURL(new URL(decodeEntities(href), base)).href; } catch { return ''; }
}

function timestamp(input) {
  const n = Date.parse(value(input));
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}

export function parseFeed(xml, baseURL) {
  // Do not resolve XML entities or allow external DTDs from untrusted sources.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('订阅内容包含不支持的 XML 声明');
  // Some official feeds append browser scripts after an otherwise complete XML root.
  // Discard only trailing script elements; never execute scripts or relax XML validation.
  const appendedScripts = /^(\s*(?:<\?xml[\s\S]*?\?>\s*)?<(feed|rss)\b[\s\S]*?<\/\2\s*>)(\s*(?:<script\b[^>]*>[\s\S]*?<\/script>\s*)+)$/i.exec(xml);
  if (appendedScripts) xml = appendedScripts[1];
  if (XMLValidator.validate(xml) !== true) throw new Error('订阅内容不是有效 XML');
  const doc = parser.parse(xml);
  const entries = doc.feed?.entry ?? doc.rss?.channel?.item ?? doc.RDF?.item;
  if (!doc.feed && !doc.rss && !doc.RDF) throw new Error('网址未返回 RSS 或 Atom');
  const roots = Object.keys(doc).filter(key => !key.startsWith('?'));
  if (roots.length !== 1 || Array.isArray(doc[roots[0]])) throw new Error('订阅内容不是有效 XML：需要单个根元素');
  return array(entries).map(entry => {
    const links = array(entry.link);
    const link = links.find(item => typeof item === 'object' && (!item['@_rel'] || item['@_rel'] === 'alternate')) || links.find(item => typeof item === 'string');
    const href = typeof link === 'object' ? link?.['@_href'] : value(link);
    const guid = entry.guid && entry.guid['@_isPermaLink'] !== 'false' ? value(entry.guid) : '';
    return {
      url: absoluteURL(href || guid || value(entry.id), baseURL),
      title: plainText(value(entry.title)).slice(0, 300),
      publishedAt: timestamp(entry.published || entry.pubDate || entry.date || entry.updated),
      excerpt: plainText(value(entry.summary || entry.description || entry.encoded || entry.content)).slice(0, 2400),
    };
  }).filter(entry => entry.url && entry.title);
}

export function discoverFeeds(html, baseURL) {
  const urls = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const link = attrs(match[0]);
    if (link.rel?.split(/\s+/).includes('alternate') && /(?:rss|atom)\+xml/i.test(link.type || '')) {
      const url = absoluteURL(link.href, baseURL);
      if (url) urls.push(url);
    }
  }
  return [...new Set(urls)];
}

export function discoverArticles(html, baseURL) {
  const base = new URL(baseURL);
  const articles = [];
  // Require an article element or a recognizable article path, never blindly crawl navigation.
  const blocks = [...html.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/gi)].map(match => match[0]);
  const sections = blocks.length ? blocks : [html];
  for (const section of sections) {
    for (const match of section.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const attr = attrs(match[1]);
      if (!attr.href) continue;
      const url = absoluteURL(attr.href, baseURL);
      if (!url) continue;
      const target = new URL(url);
      const title = plainText(match[2]);
      if (target.origin !== base.origin || target.pathname.replace(/\/$/, '') === base.pathname.replace(/\/$/, '') || title.length < 12 || title.length > 300) continue;
      if (/\/(?:tag|tags|category|categories|author|search|page|about|contact|privacy|subscribe)(?:\/|$)/i.test(target.pathname) || /\.(?:png|jpe?g|svg|pdf|zip)$/i.test(target.pathname)) continue;
      if (!blocks.length && !/\/(?:blog|posts?|articles?|news|engineering|tech-blog|\d{4})\/.+/i.test(target.pathname)) continue;
      articles.push({ url, title, publishedAt: null, excerpt: '' });
    }
  }
  return articles.filter((entry, index) => articles.findIndex(other => other.url === entry.url) === index);
}

export function extractArticle(html) {
  const main = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] || html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || '';
  let description = '';
  let publishedAt = null;
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attr = attrs(match[0]);
    if (['description','og:description'].includes(attr.name || attr.property)) description ||= plainText(attr.content);
    if (['article:published_time','date','datePublished'].includes(attr.property || attr.name)) publishedAt ||= timestamp(attr.content);
  }
  const time = html.match(/<time\b[^>]*>/i);
  if (time) publishedAt ||= timestamp(attrs(time[0]).datetime);
  return { excerpt: (plainText(main) || description).slice(0, 2400), publishedAt };
}

/** External article bodies exist only in memory; return bounded excerpts for analysis. */
export async function collectSource(source, { limit = 5, sinceDays = 30, fetcher = fetchText, expand = true } = {}) {
  const count = Math.max(1, Math.min(20, Number(limit) || 5));
  const cutoff = Date.now() - Math.max(1, Number(sinceDays) || 30) * 86400000;
  let feedUrl = source.feedUrl || '';
  let feedError;
  try {
    let entries;
    if (feedUrl) {
      try { entries = parseFeed(await fetcher(feedUrl), feedUrl); }
      catch (error) { feedError = error; }
    }
    if (!entries) {
      const homepage = await fetcher(source.url);
      if (/^\s*(?:<\?xml[^>]*>\s*)?<(?:rss|feed|rdf:RDF)\b/i.test(homepage)) {
        entries = parseFeed(homepage, source.url);
        feedUrl = source.url;
      } else {
        for (const candidate of discoverFeeds(homepage, source.url).slice(0, 3)) {
          if (candidate === feedUrl) continue;
          try { entries = parseFeed(await fetcher(candidate), candidate); feedUrl = candidate; break; }
          catch (error) { feedError = error; }
        }
        if (!entries) { entries = discoverArticles(homepage, source.url); feedUrl = ''; }
      }
      if (!entries.length && feedError) throw feedError;
    }
    const candidates = entries.filter((entry, index) => entries.findIndex(other => other.url === entry.url) === index)
      .filter(entry => !entry.publishedAt || Date.parse(entry.publishedAt) >= cutoff)
      .sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0))
      .slice(0, count);
    const articles = [];
    for (const entry of candidates) {
      // RSS summaries may suffice. Expand short ones, without persisting the body.
      if (expand && entry.excerpt.length < 350) {
        try {
          const extracted = extractArticle(await fetcher(entry.url, { maxBytes: 2_000_000, timeoutMs: 15_000 }));
          if (extracted.excerpt.length > entry.excerpt.length) entry.excerpt = extracted.excerpt;
          entry.publishedAt ||= extracted.publishedAt;
        } catch { /* A feed entry is still usable if its page is unavailable. */ }
      }
      if (entry.publishedAt && Date.parse(entry.publishedAt) < cutoff) continue;
      articles.push({ ...entry, topics: [...(source.topics || [])], sourceId: source.id, sourceName: source.name });
    }
    return { articles, feedUrl, status: articles.length ? 'success' : 'empty' };
  } catch (error) {
    return { articles: [], feedUrl, status: 'error', error: (feedError ? `订阅失败：${feedError.message}；网页回退失败：${error.message || error}` : String(error.message || error)).slice(0, 500) };
  }
}
