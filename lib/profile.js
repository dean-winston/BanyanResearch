import { fetchText, fetchJSON } from '#network';

const API = 'https://api.github.com';
const encodePath = value => value.split('/').map(encodeURIComponent).join('/');
function identity(owner, repo) {
  if (!/^[a-zA-Z0-9-]+$/.test(owner) || (repo && !/^[a-zA-Z0-9_.-]+$/.test(repo))) throw new Error('无效的 GitHub 仓库名称');
  return `${owner}/${repo}`;
}
async function mapBounded(items, visit, concurrency = 4) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) await visit(items[cursor++]);
  }));
}
function client(options) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'BanyanResearch', 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return {
    json: path => (options.fetchJSON || fetchJSON)(`${API}${path}`, { headers, maxBytes: 12 * 1024 * 1024 }),
    // Credentials are never sent to raw content hosts.
    text: url => (options.fetchText || fetchText)(url, { maxBytes: 2 * 1024 * 1024, timeoutMs: 8000 }),
  };
}
function scalar(value) {
  value = value.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value.replace(/\s+#.*$/, '').trim();
}
// Deliberately parses only inert frontmatter fields; no YAML tags or executable extensions.
export function parseArticle(content, path, { owner, repo, sha, siteURL } = {}) {
  const match = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(content);
  if (!match) return null;
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    if (field) meta[field[1]] = scalar(field[2]);
  }
  if (!meta.title || meta.published === 'false' || meta.draft === 'true') return null;
  if (meta.layout !== 'article' && meta.layout !== 'post' && !path.startsWith('_posts/')) return null;
  const topics = [...new Set([meta.category, meta.topic, ...(meta.tags || '').replace(/^\[|\]$/g, '').split(',').map(scalar)].filter(Boolean))];
  const base = siteURL || `https://${owner}.github.io/${repo === `${owner}.github.io` ? '' : `${repo}/`}`;
  let url;
  try {
    if (meta.permalink && !meta.permalink.includes(':')) url = new URL(meta.permalink, base).href;
    else if (!path.startsWith('_posts/')) url = new URL(encodePath(path.replace(/\.(md|markdown)$/i, '.html')), base).href;
  } catch { /* fall back to the exact source when routing is unknown */ }
  if (!url || !/^https?:\/\//.test(url)) url = `https://github.com/${owner}/${repo}/blob/${sha}/${encodePath(path)}`;
  return { id: `blog:${owner}/${repo}:${path}`, title: meta.title, url, path, content, sha, publishedAt: meta.published_at || meta.date || null, updatedAt: meta.updated_at || null, topics };
}
async function repositoryHead(c, fullName, branch) {
  const repo = await c.json(`/repos/${fullName}`);
  if (repo.private) throw new Error('第一版仅同步公开仓库');
  const commit = await c.json(`/repos/${fullName}/commits/${encodeURIComponent(branch || repo.default_branch || 'main')}`);
  if (!/^[a-f0-9]{40,64}$/i.test(commit.sha || '')) throw new Error('GitHub 返回了无效的提交标识');
  return { sha: commit.sha, treeSha: commit.commit?.tree?.sha || commit.sha, repo };
}
async function repositoryTree(c, fullName, treeSha, warnings) {
  const result = await c.json(`/repos/${fullName}/git/trees/${treeSha}?recursive=1`);
  if (!result.truncated) return result.tree || [];
  // GitHub truncates large recursive trees. Walk subtrees to avoid silent omissions.
  warnings.push('仓库目录较大，已改用逐层读取。');
  const all = [], pending = [{ sha: treeSha, prefix: '' }];
  while (pending.length) {
    const { sha, prefix } = pending.pop();
    const part = await c.json(`/repos/${fullName}/git/trees/${sha}`);
    if (part.truncated) throw new Error('GitHub 目录响应被截断，无法完整同步');
    for (const entry of part.tree || []) {
      const path = `${prefix}${entry.path}`;
      if (entry.type === 'tree') pending.push({ sha: entry.sha, prefix: `${path}/` });
      else all.push({ ...entry, path });
    }
  }
  return all;
}
async function readBlob(c, fullName, commit, file) {
  try {
    if (c.preferBlobAPI) throw new Error('原始内容域名暂时不可达');
    return await c.text(`https://raw.githubusercontent.com/${fullName}/${commit}/${encodePath(file.path)}`);
  } catch (rawError) {
    if (!/^[a-f0-9]{40,64}$/i.test(file.sha || '')) throw rawError;
    const blob = await c.json(`/repos/${fullName}/git/blobs/${file.sha}`);
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.size > 2 * 1024 * 1024) throw rawError;
    c.preferBlobAPI = true;
    return Buffer.from(blob.content, 'base64').toString('utf8');
  }
}
export async function syncBlog(options = {}) {
  const { owner = 'dean-winston', repo = 'dean-winston.github.io' } = options;
  const fullName = identity(owner, repo), c = client(options), warnings = [], articles = [];
  const head = await repositoryHead(c, fullName);
  const tree = await repositoryTree(c, fullName, head.treeSha, warnings);
  const paths = tree.filter(entry => entry.type === 'blob' && /\.(md|markdown)$/i.test(entry.path) && !/(^|\/)(readme|license|changelog)\./i.test(entry.path) && !/(^|\/)(_includes|_layouts|node_modules|vendor|\.git)\//.test(entry.path));
  await mapBounded(paths, async file => {
    if (file.size > 2 * 1024 * 1024) { warnings.push(`${file.path} 超过 2 MB，未同步。`); return; }
    try {
      const content = await readBlob(c, fullName, head.sha, file);
      const article = parseArticle(content, file.path, { owner, repo, sha: head.sha, siteURL: options.siteURL });
      if (article) articles.push({ ...article, sha: file.sha, sourceCommit: head.sha });
    } catch (error) { warnings.push(`${file.path}: ${error.message}`); }
  });
  articles.sort((a, b) => a.path.localeCompare(b.path));
  return { articles, warnings };
}
export async function syncRepositories(options = {}) {
  const { owner = 'dean-winston' } = options;
  identity(owner);
  const c = client(options), repositories = [], seen = new Set();
  for (let page = 1; ; page++) {
    const rows = await c.json(`/users/${owner}/repos?type=owner&sort=full_name&per_page=100&page=${page}`);
    if (!Array.isArray(rows)) throw new Error('GitHub 仓库列表响应无效');
    for (const repo of rows) {
      if (repo.private || repo.owner?.login?.toLowerCase() !== owner.toLowerCase() || seen.has(repo.id)) continue;
      seen.add(repo.id);
      repositories.push({ id: `github:${repo.id}`, name: repo.name, fullName: repo.full_name, url: repo.html_url, fork: Boolean(repo.fork), description: repo.description || '', language: repo.language || '', defaultBranch: repo.default_branch, updatedAt: repo.pushed_at || repo.updated_at });
    }
    if (rows.length < 100) break;
  }
  return { repositories, warnings: [] };
}
export function selectEvidenceFiles(tree) {
  const code = /\.(js|ts|tsx|jsx|py|go|rs|java|cs|cpp|c|h|lua|gd|rb|ex|swift|kt)$/i;
  const score = path => /^readme(?:\.[\w-]+)?\.md$/i.test(path) ? 0 : /(^|\/)(architecture|design|overview)[^/]*\.md$/i.test(path) ? 1 : /(^|\/)(main|index|server|app|lib)\.[^/]+$/i.test(path) ? 2 : /^(src|lib|app|server)\//.test(path) ? 3 : 4;
  return tree.filter(file => file.type === 'blob' && (file.size || 0) <= 250000 && !/(^|\/)(node_modules|vendor|dist|build|\.git|test|tests|fixtures|generated)\//i.test(file.path) && !/(\.min\.|\.lock$|\.d\.ts$)/.test(file.path) && (/\.md$/i.test(file.path) || code.test(file.path))).sort((a, b) => score(a.path) - score(b.path) || a.path.localeCompare(b.path)).slice(0, 6);
}
export async function getRepositoryEvidence(repository, options = {}) {
  if (repository.fork) throw new Error('Fork 项目不生成为个人工程观点');
  const [owner, name, extra] = (repository.fullName || '').split('/');
  if (extra || !name) throw new Error('无效的 GitHub 仓库名称');
  const fullName = identity(owner, name), c = client(options), warnings = [], files = [];
  const head = await repositoryHead(c, fullName, repository.defaultBranch);
  if (head.repo.fork) throw new Error('Fork 项目不生成为个人工程观点');
  const tree = await repositoryTree(c, fullName, head.treeSha, warnings);
  await mapBounded(selectEvidenceFiles(tree), async file => {
    try {
      const content = await readBlob(c, fullName, head.sha, file);
      files.push({ path: file.path, url: `https://github.com/${fullName}/blob/${head.sha}/${encodePath(file.path)}`, content: content.slice(0, 5000), truncated: content.length > 5000 });
    } catch (error) { warnings.push(`${file.path}: ${error.message}`); }
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (!files.length) warnings.push('未找到可分析的 README、设计文档或代码文件。');
  return { sha: head.sha, files, warnings };
}
