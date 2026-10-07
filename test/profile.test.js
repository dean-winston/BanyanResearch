import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArticle, selectEvidenceFiles, syncBlog, syncRepositories, getRepositoryEvidence } from '../lib/profile.js';
const sha = 'a'.repeat(40);
const article = `---\nlayout: article\ntitle: "Agent 工程"\ncategory: AI\ntopic: tools\npublished_at: "2026-09-01T00:00:00+08:00"\n---\n# 完整正文\n保留我的原文。`;

test('blog frontmatter preserves full text, paths and ignores non-articles/drafts', () => {
  const item = parseArticle(article, 'notes/Agent 工程.md', { owner: 'dean-winston', repo: 'dean-winston.github.io', sha });
  assert.equal(item.content, article);
  assert.equal(item.url, 'https://dean-winston.github.io/notes/Agent%20%E5%B7%A5%E7%A8%8B.html');
  assert.deepEqual(item.topics, ['AI', 'tools']);
  assert.equal(parseArticle(article.replace('layout: article', 'layout: page'), 'about.md'), null);
  assert.equal(parseArticle(article.replace('layout: article', 'layout: article\ndraft: true'), 'draft.md'), null);
  assert.equal(parseArticle('no frontmatter', 'README.md'), null);
});

test('repository inventory paginates and excludes private or another owner, preserves fork flag', async () => {
  const row = i => ({ id: i, owner: { login: 'dean-winston' }, name: `r${i}`, full_name: `dean-winston/r${i}`, fork: i === 2 });
  const seen = [];
  const result = await syncRepositories({ fetchJSON: async url => {
    seen.push(url);
    return url.endsWith('page=1') ? Array.from({ length: 100 }, (_, i) => row(i)) : [row(101), { ...row(102), private: true }, { ...row(103), owner: { login: 'other' } }];
  } });
  assert.equal(seen.length, 2);
  assert.equal(result.repositories.length, 101);
  assert.equal(result.repositories.find(r => r.id === 'github:2').fork, true);
});

test('blog sync uses immutable commit, blob change key and reports individual read failures', async () => {
  const result = await syncBlog({ fetchJSON: async url => {
    if (url.includes('/commits/')) return { sha, commit: { tree: { sha } } };
    if (url.includes('/git/trees/')) return { tree: [
      { type: 'blob', path: 'post.md', sha: 'blob123' },
      { type: 'blob', path: 'README.md' },
      { type: 'blob', path: 'bad.md' },
    ] };
    return { default_branch: 'main', private: false };
  }, fetchText: async (url, options) => {
    assert.ok(url.includes(`/${sha}/`));
    assert.equal(options.headers, undefined);
    if (url.endsWith('/bad.md')) throw new Error('unavailable');
    return article;
  } });
  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0].sha, 'blob123');
  assert.equal(result.articles[0].sourceCommit, sha);
  assert.equal(result.warnings.length, 1);
});

test('evidence excludes dependency/generated files, bounds size and keeps commit-linked excerpts', async () => {
  const tree = ['src/main.ts', 'README.md', 'node_modules/x/index.js', 'dist/index.js', 'docs/design.md', 'tests/main.ts'].map(path => ({ path, type: 'blob', size: 100 }));
  assert.deepEqual(selectEvidenceFiles(tree).map(x => x.path), ['README.md', 'docs/design.md', 'src/main.ts']);
  const result = await getRepositoryEvidence({ fullName: 'dean-winston/project', fork: false }, {
    fetchJSON: async url => url.includes('/commits/') ? { sha } : url.includes('/git/trees/') ? { tree } : { default_branch: 'main', private: false },
    fetchText: async () => 'x'.repeat(6000),
  });
  assert.equal(result.files.length, 3);
  assert.equal(result.files[0].content.length, 5000);
  assert.equal(result.files[0].truncated, true);
  assert.ok(result.files.every(f => f.url.includes(`/blob/${sha}/`)));
  await assert.rejects(getRepositoryEvidence({ fullName: 'dean-winston/fork', fork: true }), /Fork/);
  await assert.rejects(getRepositoryEvidence({ fullName: 'dean-winston/private' }, { fetchJSON: async () => ({ private: true }) }), /公开/);
});

test('truncated GitHub recursive tree falls back to walking every subtree', async () => {
  const result = await syncBlog({ fetchJSON: async url => {
    if (url.includes('/commits/')) return { sha };
    if (url.includes('?recursive=1')) return { truncated: true, tree: [] };
    if (url.endsWith(`/git/trees/${sha}`)) return { tree: [{ type: 'tree', path: 'notes', sha: 'subtree' }] };
    if (url.endsWith('/git/trees/subtree')) return { tree: [{ type: 'blob', path: 'entry.md', sha: 'blob' }] };
    return { default_branch: 'main', private: false };
  }, fetchText: async () => article });
  assert.equal(result.articles[0].path, 'notes/entry.md');
  assert.equal(result.warnings.length, 1);
});

test('raw host outage falls back to GitHub blobs API without losing full blog contents', async () => {
  const result = await syncBlog({ fetchJSON: async url => {
    if (url.includes('/commits/')) return { sha };
    if (url.includes('/git/trees/')) return { tree: [{ type: 'blob', path: 'entry.md', sha }] };
    if (url.includes('/git/blobs/')) return { encoding: 'base64', content: Buffer.from(article).toString('base64'), size: Buffer.byteLength(article) };
    return { default_branch: 'main', private: false };
  }, fetchText: async () => { throw new Error('timeout'); } });
  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0].content, article);
  assert.equal(result.warnings.length, 0);
});
