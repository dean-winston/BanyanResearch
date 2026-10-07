import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, discoverFeeds, discoverArticles, extractArticle, collectSource } from '../lib/collect.js';
import { isPublicAddress, publicURL, fetchText } from '../lib/network.js';

test('RSS preserves titles, canonical links, dates and plain excerpts without executing entities', () => {
  const result = parseFeed(`<rss version="2.0"><channel><item><title>Queues &amp; retries</title><link>https://example.com/posts/queues?a=1&amp;b=2</link><pubDate>Wed, 01 Oct 2025 12:00:00 GMT</pubDate><description><![CDATA[<p>A queue <strong>design</strong>.</p><script>bad()</script>]]></description></item></channel></rss>`, 'https://example.com/rss');
  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'Queues & retries');
  assert.equal(result[0].url, 'https://example.com/posts/queues?a=1&b=2');
  assert.equal(result[0].publishedAt, '2025-10-01T12:00:00.000Z');
  assert.equal(result[0].excerpt, 'A queue design .');
  assert.throws(() => parseFeed('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>', 'https://example.com'), /XML/);
  assert.throws(() => parseFeed('<html><body>Denied</body></html>', 'https://example.com'), /RSS/);
  assert.deepEqual(parseFeed('<rss><channel><item><title>No article URL</title></item></channel></rss>', 'https://example.com/rss'), []);
});

test('Atom selects alternate over self links and supports relative links and XHTML', () => {
  const result = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>New model evaluation</title><link rel="self" href="/atom/1"/><link rel="alternate" href="/posts/eval"/><updated>2025-01-01T00:00:00Z</updated><summary>A &lt;b&gt;useful&lt;/b&gt; article.</summary></entry></feed>`, 'https://example.com/feed');
  assert.equal(result[0].url, 'https://example.com/posts/eval');
  assert.match(result[0].excerpt, /useful/);
});

test('HTML discovers advertised feeds and only plausible same-site articles', () => {
  const html = `<link type='application/atom+xml' href='/feed.xml' rel='alternate'><a href='/about'>About our company</a><a href='https://other.example/blog/post'>Other site article</a><a href='/blog/queue-design'>Designing reliable queues</a><a href='/tags/testing'>Testing article category</a><a href='/blog/queue-design'>Designing reliable queues</a>`;
  assert.deepEqual(discoverFeeds(html, 'https://example.com'), ['https://example.com/feed.xml']);
  assert.deepEqual(discoverArticles(html, 'https://example.com').map(item => item.url), ['https://example.com/blog/queue-design']);
  assert.equal(extractArticle('<main><nav>Navigation</nav><p>Actual article</p><script>bad</script></main>').excerpt, 'Actual article');
});

test('collection discovers feed, filters old posts, enriches short entries, and retains unknown dates', async () => {
  const now = new Date().toISOString();
  const responses = {
    'https://example.com/': '<link rel="alternate" type="application/rss+xml" href="/rss">',
    'https://example.com/rss': `<rss><channel><item><title>Recent article</title><link>https://example.com/blog/new</link><pubDate>${now}</pubDate><description>Short</description></item><item><title>Old article</title><link>https://example.com/blog/old</link><pubDate>2001-01-01</pubDate></item><item><title>Undated article</title><link>https://example.com/blog/unknown</link></item><item><title>Duplicate article</title><link>https://example.com/blog/new</link></item></channel></rss>`,
    'https://example.com/blog/new': '<article><p>Longer useful technical evidence about queues.</p></article>',
    'https://example.com/blog/unknown': '<main>Unknown publication time is preserved.</main>',
  };
  const fetched = [];
  const fetcher = async url => { fetched.push(url); if (!(url in responses)) throw new Error('Unexpected URL'); return responses[url]; };
  const result = await collectSource({ id: 'source', name: 'Example', url: 'https://example.com/', topics: ['backend'] }, { fetcher });
  assert.equal(result.status, 'success');
  assert.equal(result.feedUrl, 'https://example.com/rss');
  assert.equal(result.articles.length, 2);
  assert.match(result.articles[0].excerpt, /technical evidence/);
  assert.equal(result.articles[1].publishedAt, null);
  assert.equal(result.articles[0].sourceId, 'source');
  assert.deepEqual(result.articles[0].topics, ['backend']);
  assert(!fetched.includes('https://example.com/blog/old'));
});

test('feed failures fall back to explicit article links and page date filter remains enforced', async () => {
  const source = { id: 'test', name: 'Example', url: 'https://example.com/', feedUrl: 'https://example.com/broken' };
  const result = await collectSource(source, { fetcher: async url => {
    if (url.endsWith('/broken')) throw new Error('HTTP 404');
    if (url === source.url) return '<article><a href="/some-post">Detailed old engineering article</a></article>';
    return '<meta property="article:published_time" content="2001-01-01"><article>Old evidence</article>';
  } });
  assert.equal(result.status, 'empty');
  assert.equal(result.feedUrl, '');
  const failed = await collectSource(source, { fetcher: async () => { throw new Error('HTTP 403'); } });
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /403/);
});

test('public fetch rejects local, metadata, credentials and non HTTP(S) destinations', async () => {
  for (const address of ['127.0.0.1','10.0.1.2','169.254.169.254','192.168.1.1','100.64.0.1','::1','::ffff:127.0.0.1','fc00::1','2001:db8::1','2002:7f00:1::']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  for (const url of ['http://127.0.0.1','http://2130706433','http://[::1]','http://localhost','file:///etc/passwd','https://user:pass@example.com']) assert.throws(() => publicURL(url));
  await assert.rejects(fetchText('http://169.254.169.254/latest/meta-data'), /内网/);
});
test('official Atom feed tolerates only appended browser scripts while retaining XML validation',()=>{
 const xml='<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Official update</title><link href="https://example.com/post"/><updated>2026-10-01T00:00:00Z</updated><summary>Evidence</summary></entry></feed>';
 const parsed=parseFeed(xml+'<script>throw new Error("must never execute");</script>','https://example.com/rss');
 assert.equal(parsed.length,1);assert.equal(parsed[0].url,'https://example.com/post');
 assert.throws(()=>parseFeed(xml+'<feed/>','https://example.com/rss'),/XML/);
 assert.throws(()=>parseFeed(xml.replace('</entry>','')+'<script></script>','https://example.com/rss'),/XML/);
 assert.throws(()=>parseFeed('<!DOCTYPE feed>'+xml+'<script></script>','https://example.com/rss'),/XML/);
});
test('failed official feed retains its own error when homepage fallback also fails',async()=>{
 const result=await collectSource({url:'https://example.com/',feedUrl:'https://example.com/feed'}, {fetcher:async url=>{throw new Error(url.endsWith('/feed')?'HTTP 429: official feed':'HTTP 403: homepage');}});
 assert.equal(result.status,'error');assert.match(result.error,/429.*official feed/);assert.match(result.error,/403.*homepage/);
});
