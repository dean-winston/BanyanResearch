import {applySettings,claimAgentCheck} from './lib/settings.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readStore, updateStore, initializeStore } from './lib/store.js';
import { knowledgeItems } from './lib/knowledge.js';
import { createJobRunner } from './lib/jobs.js';
import { runtimeStatus, runStructured } from './lib/analyzer.js';
import { changeAgent, changeAgentSettings, planAgent, finishAgent, makeDurableJob } from './lib/agents.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const port = Number(process.env.PORT || 4173);
const categories = new Set(['research', 'engineering', 'writing']);
const importExtensions = new Set(['.md', '.markdown', '.txt', '.js', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.json', '.yaml', '.yml']);
const ignoredDirectories = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.venv', 'venv', '.data']);

const jobs = createJobRunner();
const runtime = { ...await runtimeStatus(), deployment: 'local' };
let agentWake = null;
const jobSubmissions = new Set();
function enqueueLocalJob(type, repositoryId) {
  if (agentWake) throw Object.assign(new Error('助手正在执行，请等待本轮完成后提交手动任务'), { status: 409 });
  const submitted = jobs.enqueue(type, repositoryId);
  jobSubmissions.add(submitted);
  submitted.finally(() => jobSubmissions.delete(submitted)).catch(() => {});
  return submitted;
}
function wakeAgents() {
  if (agentWake) return { accepted: false, reason: '助手正在执行本轮任务' };
  const wakeId = crypto.randomUUID();
  // Reserve before awaiting the existing queue; new manual jobs cannot race the wake.
  agentWake = (async () => {
    await Promise.allSettled([...jobSubmissions]);
    await jobs.idle();
    for (const agentId of ['writing', 'research']) {
      try {
        const decision = await planAgent(agentId, wakeId);
        if (!decision) continue;
        if (decision.action === 'wait') { await finishAgent(decision); continue; }
        const current = await readStore();
        if (!current.agentSettings.enabled || !current.agents.find(a => a.id === agentId)?.enabled) {
          await finishAgent(decision, { status: 'success', message: '助手已暂停，未执行本轮动作' }); continue;
        }
        const job = await makeDurableJob(decision.action, decision.jobId);
        await jobs.execute(job);
        const result = (await readStore()).jobs.find(j => j.id === job.id);
        await finishAgent(decision, result);
      } catch (error) { console.error('本地助手本轮失败：', error.message); }
    }
  })().catch(error => console.error('本地助手唤醒失败：', error.message)).finally(() => { agentWake = null; });
  return { accepted: true, wakeId };
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function body(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw Object.assign(new Error('请求内容过大'), { status: 413 });
  }
  try { const value=JSON.parse(raw || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw Object.assign(new Error('JSON 格式无效'), { status: 400 }); }
}

function cleanText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function makeItem(input) {
  const category = cleanText(input.category, 32);
  const title = cleanText(input.title, 200);
  const content = cleanText(input.content, 100_000);
  if (!categories.has(category) || !title || !content) {
    throw Object.assign(new Error('请填写分类、标题和内容'), { status: 400 });
  }
  return {
    id: crypto.randomUUID(), category, title, content,
    source: cleanText(input.source, 1000),
    createdAt: new Date().toISOString(),
  };
}

function tokenize(text) {
  return (text.toLowerCase().match(/[\p{Script=Han}]|[a-z0-9_]{2,}/gu) || []);
}

function rankItems(items, question) {
  const terms = [...new Set(tokenize(question))];
  return items.map(item => {
    const title = item.title.toLowerCase();
    const content = item.content.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (title.includes(term) ? 4 : 0) + (content.includes(term) ? 1 : 0), 0);
    return { item, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || b.item.createdAt.localeCompare(a.item.createdAt));
}

async function importFolder(folder, category) {
  if (!categories.has(category)) throw Object.assign(new Error('分类无效'), { status: 400 });
  if (typeof folder !== 'string' || !folder.trim() || !path.isAbsolute(folder)) {
    throw Object.assign(new Error('请输入文件夹的绝对路径'), { status: 400 });
  }
  const absolute = path.resolve(folder.trim());
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat?.isDirectory()) throw Object.assign(new Error('目录不存在'), { status: 400 });
  const found = [];
  async function visit(dir, depth) {
    if (depth > 8 || found.length >= 300) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (found.length >= 300) break;
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name) && !entry.name.startsWith('.')) await visit(filename, depth + 1);
      if (!entry.isFile() || !importExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      const size = (await fs.stat(filename)).size;
      if (size > 100_000) continue;
      const content = await fs.readFile(filename, 'utf8').catch(() => '');
      if (content.trim()) found.push({ category, title: path.relative(absolute, filename), content, source: filename });
    }
  }
  await visit(absolute, 0);
  return updateStore(store => {
    const bySource = new Map(store.items.map((item, index) => [item.source, index]));
    let added = 0, updated = 0;
    for (const record of found) {
      const item = makeItem(record);
      const index = bySource.get(record.source);
      if (index === undefined) { store.items.push(item); added++; }
      else {
        store.items[index] = { ...item, id: store.items[index].id, createdAt: store.items[index].createdAt };
        updated++;
      }
    }
    return { added, updated, scanned: found.length };
  });
}

async function answerQuestion(question) {
  const store = await readStore();
  const selected = rankItems(knowledgeItems(store), question).slice(0, 10).map(x => x.item);
  if (!selected.length) return { answer: '知识库里还没有找到相关资料。请先添加内容，或换一种问法。', sources: [] };
  const context = selected.map((item, index) => ({ index: index + 1, title: item.title, category: item.category, content: item.content.slice(0, 7000) }));
  const result = await runStructured('只根据资料回答问题，具体结论用 [1] 这样的来源编号引用，资料不足明确说明。', { question, context }, {type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false});
  return { answer: result.answer, sources: selected.map(({ id, title, category, source }) => ({ id, title, category, source })) };

}

async function serveStatic(url, response) {
  const target = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const absolute = path.resolve(publicDir, target);
  if (!absolute.startsWith(publicDir + path.sep)) return json(response, 404, { error: '未找到' });
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
  try {
    const file = await fs.readFile(absolute);
    response.writeHead(200, { 'Content-Type': `${types[path.extname(absolute)] || 'application/octet-stream'}; charset=utf-8` });
    response.end(file);
  } catch { json(response, 404, { error: '未找到' }); }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  try {
    const host = request.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return json(response, 403, {error:'仅允许本机访问'});
    if (!['GET', 'HEAD'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin && origin !== `http://${host}`) return json(response,403,{error:'跨站请求已拒绝'});
      if (!(request.headers['content-type'] || '').startsWith('application/json')) return json(response,415,{error:'请使用 application/json'});
    }
    if (request.method === 'GET'  && url.pathname === '/api/state') {
      const store = await readStore();
      return json(response, 200, { ...store, items: knowledgeItems(store), runtime, modelEnabled: runtime.available });
    }
    if (request.method === 'PATCH' && url.pathname === '/api/agent-settings') {
      return json(response, 200, await changeAgentSettings(await body(request)));
    }
    if (request.method === 'PATCH' && url.pathname.startsWith('/api/agents/')) {
      return json(response, 200, await changeAgent(decodeURIComponent(url.pathname.split('/').pop()), await body(request)));
    }
    if (request.method === 'POST' && url.pathname === '/api/agents/wake') {
      await body(request);
      if (!(await readStore()).agentSettings.enabled) return json(response, 409, { error: '请先开启持续助手' });
      return json(response, 202, wakeAgents());
    }
    if (request.method === 'POST' && url.pathname === '/api/jobs') {
      if (agentWake) return json(response, 409, { error: '助手正在执行，请等待本轮完成后提交手动任务' });
      const input = await body(request);
      return json(response, 202, await enqueueLocalJob(input.type, input.repositoryId));
    }
    if (request.method === 'PATCH' && url.pathname.startsWith('/api/recommendations/')) {
      const input = await body(request), id = decodeURIComponent(url.pathname.split('/').pop());
      if (!['new','useful','irrelevant','known','later'].includes(input.feedback)) throw Object.assign(new Error('反馈类型无效'),{status:400});
      const result = await updateStore(s => {const r=s.recommendations.find(r=>r.id===id);if(!r)throw Object.assign(new Error('推荐不存在'),{status:404});r.feedback=input.feedback;r.feedbackAt=new Date().toISOString();return r;});
      return json(response,200,result);
    }
    if ((request.method === 'POST' && url.pathname === '/api/questions') || (request.method === 'PATCH' && url.pathname.startsWith('/api/questions/'))) {
      const input=await body(request);
      const result=await updateStore(s=>{
        const id=decodeURIComponent(url.pathname.split('/').pop());
        const old=request.method==='PATCH'?s.questions.find(q=>q.id===id):null;
        if(request.method==='PATCH'&&!old)throw Object.assign(new Error('研究问题不存在'),{status:404});
        const draft={...old,...input},title=cleanText(draft.title,300);
        if(!title||!['active','paused','resolved'].includes(draft.status)||!Array.isArray(draft.topics)||draft.topics.some(t=>!['ai','game','backend'].includes(t)))throw Object.assign(new Error('问题标题、状态或领域无效'),{status:400});
        let link='';if(draft.url){try{const u=new URL(draft.url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error();link=u.href;}catch{throw Object.assign(new Error('资料网址无效'),{status:400});}}
        const result={...old,id:old?.id||crypto.randomUUID(),title,notes:cleanText(draft.notes,4000),status:draft.status,topics:[...new Set(draft.topics)],url:link,origin:old?.origin||'manual',createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),humanEdited:true};
        if(old){Object.assign(old,result);for(const r of s.recommendations)if(r.relations?.some(link=>link.kind==='question'&&link.id===old.id)){r.stale=true;r.staleReason='关联研究问题已修改，需重新生成推荐';}}else s.questions.unshift(result);return result;
      });
      return json(response,request.method==='POST'?201:200,result);
    }
    if (request.method === 'PATCH' && url.pathname === '/api/settings') {
      const input=await body(request);
      return json(response,200,await updateStore(s=>applySettings(s.settings,input)));
    }
    if ((request.method === 'POST' && url.pathname === '/api/sources') || (request.method === 'PATCH' && url.pathname.startsWith('/api/sources/'))) {
      const input = await body(request);
      const source = await updateStore(store => {
        const existing = request.method === 'PATCH' ? store.sources.find(s => s.id === url.pathname.split('/').pop()) : null;
        if (request.method === 'PATCH' && !existing) throw Object.assign(new Error('信息源不存在'), { status: 404 });
        const draft = { ...existing, ...input };
        const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
        const webUrl = (value, optional = false) => {
          if (!value && optional) return '';
          try { const u = new URL(value); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return fail('请输入 HTTP 或 HTTPS 网址'); u.hash = ''; return u.href; }
          catch { return fail('请输入有效网址'); }
        };
        const name = cleanText(draft.name, 160);
        if (!name || !['blogger', 'company', 'news'].includes(draft.type)) fail('请填写名称和来源类型');
        if (!Array.isArray(draft.topics) || !draft.topics.length || draft.topics.some(t => !['ai', 'game', 'backend'].includes(t))) fail('请选择至少一个有效领域');
        if (typeof draft.enabled !== 'boolean') fail('启用状态无效');
        if (!['en', 'zh', 'other'].includes(draft.language)) fail('语言无效');
        const sourceUrl = webUrl(draft.url);
        if (store.sources.some(s => s.id !== existing?.id && s.url.replace(/\/$/, '') === sourceUrl.replace(/\/$/, ''))) fail('这个网址已经在列表中');
        const changedUrl = existing && (existing.url !== sourceUrl || existing.feedUrl !== (draft.feedUrl || ''));
        const result = { ...existing, id: existing?.id || crypto.randomUUID(), name, url: sourceUrl, feedUrl: webUrl(draft.feedUrl, true), type: draft.type, topics: [...new Set(draft.topics)], notes: cleanText(draft.notes, 4000), language: draft.language, enabled: draft.enabled, updatedAt: new Date().toISOString() };
        if (!existing || changedUrl) { result.verification = '待验证'; result.checkedAt = ''; result.httpStatus = ''; }
        if (existing) {store.sources[store.sources.indexOf(existing)] = result; if(changedUrl)for(const r of store.recommendations){const article=store.articles.find(a=>a.id===r.articleId);if(article?.sourceId===existing.id){r.stale=true;r.staleReason='信息源网址已修改，原有推荐待复核';}}}
        else store.sources.unshift(result);
        return result;
      });
      return json(response, request.method === 'POST' ? 201 : 200, source);
    }
    if (request.method === 'POST' && url.pathname === '/api/items') {
      const item = makeItem(await body(request));
      await updateStore(store => { store.items.unshift(item); });
      return json(response, 201, item);
    }
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/items/')) {
      const id = url.pathname.split('/').pop();
      const deleted = await updateStore(store => {
        const previous = store.items.length;
        store.items = store.items.filter(item => item.id !== id);
        return previous !== store.items.length;
      });
      return json(response, deleted ? 200 : 404, { deleted });
    }
    if (request.method === 'POST' && url.pathname === '/api/import') {
      const input = await body(request);
      return json(response, 200, await importFolder(input.folder, input.category));
    }
    if (request.method === 'POST' && url.pathname === '/api/ask') {
      const question = cleanText((await body(request)).question, 2000);
      if (!question) throw Object.assign(new Error('请输入问题'), { status: 400 });
      const result = await answerQuestion(question);
      await updateStore(store => { store.answers.unshift({ id: crypto.randomUUID(), question, ...result, createdAt: new Date().toISOString() }); store.answers = store.answers.slice(0, 50); });
      return json(response, 200, result);
    }
    if (request.method === 'GET') return serveStatic(url, response);
    json(response, 404, { error: '未找到' });
  } catch (error) {
    console.error(error);
    json(response, error.status || 500, { error: error.status ? error.message : '服务器处理失败' });
  }
});

await initializeStore();
if (process.env.DISABLE_SCHEDULER !== '1') {
  const timer=setInterval(async()=>{
    try{const store=await readStore();if(store.agentSettings.enabled){if(!agentWake && await updateStore(s=>claimAgentCheck(s)) && store.agents.some(a=>a.id!=='engineering'&&a.enabled&&(!a.nextWakeAt||Date.parse(a.nextWakeAt)<=Date.now())))wakeAgents();}else if(!agentWake && store.settings.dailyEnabled && !store.jobs.some(j=>['running','queued'].includes(j.status)) && Date.now()-new Date(store.settings.lastDailyAt||0).getTime()>=86400000)await enqueueLocalJob('daily');}
    catch(error){console.error('每日调度失败：',error.message);}
  },60000);
  timer.unref();
}
server.listen(port, '127.0.0.1', () => console.log(`BanyanResearch: http://127.0.0.1:${server.address().port}`));

for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.close();process.exit(0);});
