const labels = { research: '外部世界', engineering: '工程活动', writing: '思想演化' };
const icons = { research: '⌕', engineering: '⌘', writing: '✎' };
let state = { items: [], answers: [], modelEnabled: false };
let currentFilter = 'all';
let currentItem = null;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (response.status === 401) showLogin();
  if (!response.ok) { const error = new Error(data.error || `请求失败 (${response.status})`); error.status = response.status; throw error; }
  return data;
}

let toastTimer;
function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 3200);
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function dateLabel(iso) {
  return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
}

function showView(name) {
  if (!['inbox', 'profile', 'questions', 'agents', 'tasks', 'overview', 'knowledge', 'ask', 'sources'].includes(name)) return;
  history.replaceState(null, '', '#' + name);
  $$('.view').forEach(view => view.classList.toggle('active', view.id === name));
  $$('.nav').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  $('#pageName').textContent = { agents: '持续助手', inbox: '为你推荐', profile: '我的研究', questions: '研究问题', tasks: '更新与任务', overview: '总览', knowledge: '知识库', ask: '智能分析', sources: '信息源管理' }[name];
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function row(item) {
  const button = document.createElement('button');
  button.className = `item-row ${item.category}`;
  button.innerHTML = `<span class="item-badge">${icons[item.category]}</span><span><span class="item-title">${escapeHTML(item.title)}</span><span class="item-sub">${labels[item.category]} · ${escapeHTML(item.content.slice(0, 110).replace(/\s+/g, ' '))}</span></span><span class="item-date">${dateLabel(item.createdAt)}</span>`;
  button.addEventListener('click', () => openDetail(item.id));
  return button;
}

function renderList(container, items, emptyText) {
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }
  items.forEach(item => container.append(row(item)));
}

function render() {
  renderSources();
  renderIntelligence();
  renderAgents();
  const items = [...state.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const category of Object.keys(labels)) $('#'+category+'Count').textContent = `${items.filter(item => item.category === category).length} 条记录`;
  $('#allCount').textContent = items.length;
  $('#modelStatus').textContent = state.modelEnabled ? 'AI 分析已连接' : '本地知识库已就绪';
  renderList($('#recentList'), items.slice(0, 4), '还没有记录。添加一条想法，开始积累你的知识。');
  const query = $('#searchInput').value.trim().toLocaleLowerCase();
  const filtered = items.filter(item => (currentFilter === 'all' || item.category === currentFilter) && (!query || `${item.title} ${item.content} ${item.source}`.toLocaleLowerCase().includes(query)));
  renderList($('#knowledgeList'), filtered, query ? '没有找到匹配的资料。' : '这个视角里还没有记录。');
}

async function refresh() {
  state = await api('/api/state');
  $('#loginScreen').classList.add('hidden'); $('.shell').classList.remove('hidden');
  $('#logoutButton').classList.toggle('hidden', state.runtime?.deployment !== 'cloud');
  for (const id of ['importHero','importButton']) { $('#'+id).disabled = state.runtime?.deployment === 'cloud'; $('#'+id).title = state.runtime?.deployment === 'cloud' ? '云端无法读取本机文件夹，可使用手动添加知识' : ''; }
  $('#cloudImportNotice').classList.toggle('hidden', state.runtime?.deployment !== 'cloud');
  $('#legacyDailyControl').classList.toggle('hidden',state.runtime?.deployment === 'cloud');
  $('#dailyScheduleNote').textContent = state.runtime?.deployment === 'cloud' ? '自动运行开关和检查频率请在“持续助手”中设置；这里调整每轮采集规则。项目始终手动更新。' : '本地版本需要服务持续运行。GitHub 项目由你手动更新。';
  render();
}

function openDetail(id) {
  currentItem = state.items.find(item => item.id === id);
  if (!currentItem) return;
  $('#detailCategory').textContent = labels[currentItem.category];
  $('#detailTitle').textContent = currentItem.title;
  $('#detailMeta').textContent = `${dateLabel(currentItem.createdAt)}${currentItem.source ? ' · ' + currentItem.source : ''}`;
  $('#detailSource').innerHTML = currentItem.source ? safeLink(currentItem.source, '打开来源') : '';
  $('#deleteItem').classList.toggle('hidden', Boolean(currentItem.readOnly));
  $('#detailContent').textContent = currentItem.content;
  $('#detailDialog').showModal();
}

function renderAnswer(result) {
  const panel = $('#answerPanel');
  panel.replaceChildren();
  const heading = document.createElement('h3');
  heading.textContent = '分析结果';
  const answer = document.createElement('div');
  answer.className = 'answer-text';
  answer.textContent = result.answer;
  panel.append(heading, answer);
  if (result.sources.length) {
    const sources = document.createElement('div');
    sources.className = 'source-list';
    const label = document.createElement('b');
    label.textContent = `参考资料 · ${result.sources.length}`;
    sources.append(label);
    result.sources.forEach((source, index) => {
      const button = document.createElement('button');
      button.textContent = `[${index + 1}] ${source.title} · ${labels[source.category]}`;
      button.addEventListener('click', () => openDetail(source.id));
      sources.append(button);
    });
    panel.append(sources);
  }
  panel.classList.remove('hidden');
}

$$('.nav').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
$('#viewAll').addEventListener('click', () => showView('knowledge'));
$('#askHero').addEventListener('click', () => showView('ask'));
$$('.agent-card').forEach(button => button.addEventListener('click', () => {
  currentFilter = button.dataset.category;
  $$('.filter').forEach(filter => filter.classList.toggle('active', filter.dataset.filter === currentFilter));
  showView('knowledge'); render();
}));
$$('.filter').forEach(button => button.addEventListener('click', () => {
  currentFilter = button.dataset.filter;
  $$('.filter').forEach(filter => filter.classList.toggle('active', filter === button));
  render();
}));
$('#searchInput').addEventListener('input', render);
for (const id of ['addTop', 'addButton']) $(`#${id}`).addEventListener('click', () => $('#entryDialog').showModal());
for (const id of ['importHero', 'importButton']) $(`#${id}`).addEventListener('click', () => { if(state.runtime?.deployment === 'cloud') return toast('云端无法读取本机文件夹，可使用手动添加知识'); $('#importDialog').showModal(); });
$$('[data-close]').forEach(button => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));

$('#entryForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    await api('/api/items', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.reset(); $('#entryDialog').close(); await refresh(); toast('已保存到知识库');
  } catch (error) { toast(error.message); }
  finally { submit.disabled = false; }
});

$('#importForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type=submit]');
  if(state.runtime?.deployment === 'cloud') return toast('云端无法读取本机文件夹');
  submit.disabled = true;
  try {
    const result = await api('/api/import', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    $('#importDialog').close(); await refresh(); showView('knowledge');
    toast(`导入完成：新增 ${result.added} 条，更新 ${result.updated} 条`);
  } catch (error) { toast(error.message); }
  finally { submit.disabled = false; }
});

$('#deleteItem').addEventListener('click', async () => {
  if (!currentItem || currentItem.readOnly || !confirm(`删除“${currentItem.title}”？`)) return;
  try {
    await api(`/api/items/${currentItem.id}`, { method: 'DELETE' });
    $('#detailDialog').close(); await refresh(); toast('记录已删除');
  } catch (error) { toast(error.message); }
});

$('#askForm').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('#askSubmit');
  submit.disabled = true; submit.textContent = '正在分析…';
  try {
    const result = await api('/api/ask', { method: 'POST', body: JSON.stringify({ question: $('#question').value }) });
    renderAnswer(result);
  } catch (error) { toast(error.message); }
  finally { submit.disabled = false; submit.textContent = '✦ 生成分析'; }
});

$$('.suggestion').forEach(button => button.addEventListener('click', () => {
  $('#question').value = button.textContent.replace(/\s*↗$/, '');
  $('#question').focus();
}));

$('#today').textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
showView(location.hash.slice(1) || 'inbox');
refresh().catch(error => { toast(error.message); scheduleRefresh(10000); });

const topicNames = { ai: 'AI', game: '游戏开发', backend: '服务端' };
const typeNames = { blogger: '个人博客', company: '公司 / 官方技术站', news: '新闻媒体' };
let editingSourceId = null;
function safeLink(url, label) {
  try { if (!['http:', 'https:'].includes(new URL(url).protocol)) return ''; } catch { return ''; }
  return `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(label)} ↗</a>`;
}
function renderSources() {
  const sources = state.sources || [];
  const query = $('#sourceSearch').value.trim().toLowerCase();
  const shown = sources.filter(s => (!query || `${s.name} ${s.url} ${s.notes}`.toLowerCase().includes(query)) && (!$('#sourceTopic').value || s.topics.includes($('#sourceTopic').value)) && (!$('#sourceType').value || s.type === $('#sourceType').value) && (!$('#sourceStatus').value || s.enabled === ($('#sourceStatus').value === 'enabled')));
  $('#sourceCount').textContent = `显示 ${shown.length} / ${sources.length} 个 · 已启用 ${sources.filter(s => s.enabled).length} 个`;
  $('#sourceCards').innerHTML = shown.length ? shown.map(s => `<article class="source-card ${s.enabled ? '' : 'source-disabled'}"><div class="source-card-heading"><h3>${safeLink(s.url, s.name)}</h3><span class="source-status">${s.enabled ? '已启用' : '已停用'}</span></div><div class="source-tags"><span>${typeNames[s.type]}</span>${s.topics.map(t => `<span>${topicNames[t]}</span>`).join('')}<span>${s.language === 'zh' ? '中文' : s.language === 'en' ? '英文' : '其他语言'}</span></div><p class="source-url">${escapeHTML(s.url)}</p><p class="source-notes">${escapeHTML(s.notes || '暂无备注，点击编辑添加。')}</p><div class="source-meta">${s.provenance ? safeLink(s.provenance, '收录参考') : '手动添加'}${s.feedUrl ? ' · ' + safeLink(s.feedUrl, '订阅地址') : ' · 未填写订阅地址'}<br>${escapeHTML(s.verification || '待验证')}${s.checkedAt ? ' · ' + escapeHTML(s.checkedAt) : ''}</div>${collectionLabel(s.lastCollection)}<div class="source-actions"><button class="button outline" data-edit-source="${escapeHTML(s.id)}">编辑备注与设置</button><button class="plain-link" data-toggle-source="${escapeHTML(s.id)}">${s.enabled ? '停用' : '启用'}</button></div></article>`).join('') : '<div class="empty">没有匹配的信息源。可以调整筛选或添加新来源。</div>';
}
function editSource(source) {
  editingSourceId = source?.id || null;
  const form = $('#sourceForm'); form.reset();
  $('#sourceDialogTitle').textContent = source ? '编辑信息源' : '添加信息源';
  for (const name of ['name', 'url', 'feedUrl', 'notes', 'type', 'language']) form.elements[name].value = source?.[name] || ({type:'blogger',language:'en'}[name] || '');
  form.elements.enabled.checked = source?.enabled ?? true;
  form.querySelectorAll('[name=topics]').forEach(input => { input.checked = (source?.topics || ['ai']).includes(input.value); });
  $('#sourceDialog').showModal();
}
$('#newSource').addEventListener('click', () => editSource(null));
for (const id of ['sourceSearch', 'sourceTopic', 'sourceType', 'sourceStatus']) $('#'+id).addEventListener('input', renderSources);
$('#sourceCards').addEventListener('click', async event => {
  const edit = event.target.closest('[data-edit-source]');
  if (edit) return editSource(state.sources.find(s => s.id === edit.dataset.editSource));
  const toggle = event.target.closest('[data-toggle-source]');
  if (!toggle) return;
  const source = state.sources.find(s => s.id === toggle.dataset.toggleSource);
  toggle.disabled = true;
  try { await api('/api/sources/' + source.id, { method: 'PATCH', body: JSON.stringify({ enabled: !source.enabled }) }); await refresh(); toast(source.enabled ? '信息源已停用' : '信息源已启用'); }
  catch (error) { toast(error.message); toggle.disabled = false; }
});
$('#sourceForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, data = new FormData(form), button = form.querySelector('[type=submit]');
  const input = Object.fromEntries(data); input.topics = data.getAll('topics'); input.enabled = form.elements.enabled.checked;
  if (!input.topics.length) return toast('请至少选择一个关注领域');
  button.disabled = true;
  try { await api(editingSourceId ? '/api/sources/' + editingSourceId : '/api/sources', {method: editingSourceId ? 'PATCH' : 'POST', body: JSON.stringify(input)}); $('#sourceDialog').close(); await refresh(); toast('信息源已保存'); }
  catch(error) { toast(error.message); }
  finally { button.disabled = false; }
});

const feedbackNames = { new: '未处理', useful: '有用', irrelevant: '不相关', known: '已了解', later: '稍后看' };
const questionStatuses = { active: '正在研究', paused: '暂时搁置', resolved: '已解决' };
const jobNames = { daily: '每日更新', collect: '采集信息源', blog: '同步博客', repositories: '同步与分析项目', recommend: '生成推荐' };
const jobStatuses = { queued: '等待中', running: '进行中', success: '已完成', partial: '部分完成', failed: '失败', interrupted: '已中断' };
let editingQuestionId = null;
let pollTimer;
let settingsInitialized = false;
const blank = message => `<div class="empty">${escapeHTML(message)}</div>`;
const tags = topics => `<div class="source-tags">${(topics || []).map(t => `<span>${escapeHTML(topicNames[t] || t)}</span>`).join('')}</div>`;
const timeLabel = value => value ? new Date(value).toLocaleString('zh-CN') : '尚未运行';
function collectionLabel(result) {
  if (!result) return '<p class="collection-status">尚未采集</p>';
  return `<p class="collection-status">最近采集：${escapeHTML(({success:'采集成功',empty:'近期暂无内容',error:'采集失败'})[result.status] || jobStatuses[result.status] || result.status || '已尝试')}${Number.isInteger(result.count) ? ' · ' + result.count + ' 篇候选' : ''}${result.at || result.finishedAt ? ' · ' + escapeHTML(timeLabel(result.at || result.finishedAt)) : ''}${result.error ? '<br>' + escapeHTML(result.error) : ''}${result.message ? '<br>' + escapeHTML(result.message) : ''}</p>`;
}
function renderIntelligence() {
  const recommendations = state.recommendations || [], blogs = state.blogs || [], repos = state.repositories || [], jobs = state.jobs || [], questions = (state.questions || []).filter(q => !q.superseded);
  const query = $('#recommendSearch').value.trim().toLowerCase(), filter = $('#recommendFilter').value;
  const shown = recommendations.filter(r => (!filter || (r.feedback || 'new') === filter) && (!query || `${r.title} ${r.summary} ${r.rationale}`.toLowerCase().includes(query))).sort((a,b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  $('#recommendCount').textContent = `${shown.length} 条推荐 · ${recommendations.filter(r => !r.feedback || r.feedback === 'new').length} 条未处理`;
  $('#recommendCards').innerHTML = shown.length ? shown.map(r => `<article class="recommend-card ${r.stale ? 'recommend-stale' : ''}"><div class="card-top"><span class="eyebrow muted">${escapeHTML(feedbackNames[r.feedback || 'new'] || '未处理')}</span><span class="small-meta">${r.createdAt ? dateLabel(r.createdAt) : ''}</span></div><h2>${safeLink(r.url,r.title)}</h2>${r.stale ? `<div class="review-notice">历史推荐 · ${escapeHTML(r.staleReason || '重新分析后未入选，保留供回顾')}</div>` : ''}<p>${escapeHTML(r.summary || '')}</p><div class="recommend-reason"><b>为什么与你有关</b><p>${escapeHTML(r.rationale || '暂无推荐理由')}</p></div>${(r.relations || []).length ? `<div class="relations"><b>与你的研究关联</b>${r.relations.map(rel => `<div><span class="relation-kind">${({question:'研究问题',blog:'博客',repository:'项目'})[rel.kind] || '参考'}</span> ${safeLink(rel.url,rel.title) || escapeHTML(rel.title)}<p>${escapeHTML(rel.reason || '')}</p></div>`).join('')}</div>` : ''}<div class="small-meta">${modeLabel(r.analysisMode)}</div><div class="feedback-actions" aria-label="推荐反馈">${Object.entries(feedbackNames).filter(([value]) => value !== 'new').map(([value,label]) => `<button class="feedback-button ${(r.feedback === value) ? 'selected' : ''}" data-feedback="${value}" data-recommendation="${escapeHTML(r.id)}" aria-pressed="${r.feedback === value}">${label}</button>`).join('')}${r.feedback && r.feedback !== 'new' ? `<button class="plain-link" data-feedback="new" data-recommendation="${escapeHTML(r.id)}">撤销反馈</button>` : ''}</div></article>`).join('') : blank(query || filter ? '暂无符合筛选条件的推荐。' : '还没有推荐。添加一个研究问题，再点击“立即更新”，开始连接外部信息与你的研究。');
  const articles = state.articles || [];
  $('#articleCount').textContent = `(${articles.length})`;
  $('#articleList').innerHTML = articles.length ? articles.slice().reverse().map(a => `<article class="article-row"><h3>${safeLink(a.url,a.title)}</h3><div class="small-meta">${escapeHTML(a.sourceName || '')}${a.publishedAt ? ' · ' + escapeHTML(dateLabel(a.publishedAt)) : ''}</div><p>${escapeHTML(a.summary || '')}</p>${tags(a.topics)}</article>`).join('') : blank('还没有采集到文章。');
  $('#blogCount').textContent = blogs.length;
  $('#blogCards').innerHTML = blogs.length ? blogs.map(b => `<article class="profile-card"><h3>${safeLink(b.url,b.title)}</h3>${tags(b.topics)}<p>${escapeHTML((b.content || '').slice(0,200))}${b.content?.length > 200 ? '…' : ''}</p><button class="plain-link" data-read-blog="${escapeHTML(b.id)}">阅读已同步全文 →</button></article>`).join('') : blank('点击“同步博客”，收录你的文章和研究主题。');
  $('#repoCount').textContent = `${repos.filter(r => !r.fork).length} 个原创 · ${repos.filter(r => r.fork).length} 个 Fork`;
  $('#repoCards').innerHTML = repos.length ? repos.map(r => `<article class="profile-card"><div class="card-top"><h3>${safeLink(r.url,r.name)}</h3><span class="small-meta">${r.fork ? 'Fork' : '原创项目'}</span></div><p>${escapeHTML(r.description || '')}</p>${r.card ? `<div class="repo-viewpoint"><b>${r.card.inference ? '由代码推断的工程观点' : '工程观点'}</b><p>${textValue(r.card.viewpoint)}</p><details><summary>查看分析与代码依据</summary>${[['problem','解决的问题'],['approach','实现方法'],['tradeoffs','取舍'],['validation','验证情况']].map(([key,label]) => `<h4>${label}</h4><p>${textValue(r.card[key]) || '暂无依据'}</p>`).join('')}<h4>代码依据</h4>${(r.card.evidence || []).map(e => `<p>${safeLink(e.url,e.path || '代码位置')}</p>`).join('') || '<p>暂无代码链接</p>'}</details></div>` : `<p class="small-meta">${r.fork ? '不作为你的工程观点分析' : '尚无工程观点 · ' + escapeHTML(({pending:'等待分析',running:'分析中',success:'分析完成',failed:'分析失败',excluded:'不纳入分析'})[r.analysisStatus] || '等待分析')}</p>`}${r.analysisStatus === 'failed' ? `<p class="error-notice">本次分析失败：${escapeHTML(r.analysisError || '请查看任务详情')}${r.card ? '。页面保留上次分析结果。' : ''}</p>` : ''}${r.analysisStatus === 'running' && r.card ? '<p class="small-meta">正在重新分析，当前展示上次结果。</p>' : ''}${r.sha ? `<p class="small-meta">分析版本：<code title="${escapeHTML(r.sha)}">${escapeHTML(r.sha.slice(0,12))}</code></p>` : ''}${r.warnings?.length ? `<details class="evidence-warnings"><summary>分析范围说明（${r.warnings.length}）</summary>${r.warnings.map(w => `<p>${escapeHTML(w)}</p>`).join('')}</details>` : ''}${r.analyzedAt ? `<p class="small-meta">分析于 ${escapeHTML(timeLabel(r.analyzedAt))}</p>` : ''}${!r.fork ? `<button class="button outline" data-job="repositories" data-repository="${escapeHTML(r.id)}">${r.card ? '重新分析' : '分析项目'}</button>` : ''}</article>`).join('') : blank('点击“同步并分析项目”，建立你的工程实践档案。');
  const questionQuery = $('#questionSearch').value.trim().toLowerCase();
  const visibleQuestions = questions.filter(q => !questionQuery || `${q.title} ${q.notes}`.toLowerCase().includes(questionQuery));
  $('#questionCards').innerHTML = visibleQuestions.length ? visibleQuestions.map(q => `<article class="profile-card"><div class="small-meta">${escapeHTML(isCandidate(q) ? '待确认的候选问题' : questionStatuses[q.status] || q.status)}</div><h3>${escapeHTML(q.title)}</h3><p>${escapeHTML(q.notes || '')}</p>${tags(q.topics)}${q.url ? `<p>${safeLink(q.url,'相关资料')}</p>` : ''}${q.origin ? `<p class="small-meta">来源：${escapeHTML(typeof q.origin === 'string' ? ({manual:'手动维护',blog:'博客提取',repository:'项目分析提取'})[q.origin] || q.origin : q.origin.title || '文章提取')}</p>` : ''}${isCandidate(q) ? '<p class="candidate-note">尚未作为正在研究的问题。确认后请将状态改为“正在研究”。</p>' : ''}<button class="button outline" data-edit-question="${escapeHTML(q.id)}">${isCandidate(q) ? '确认或编辑' : '编辑问题'}</button></article>`).join('') : blank('把你正在研究的问题写下来，例如：如何让游戏中的 AI Agent 保持稳定的长期记忆？');
  const active = jobs.filter(j => j.status === 'queued' || j.status === 'running');
  $('#runningNotice').classList.toggle('hidden', !active.length);
  $('#runningNotice').textContent = active.map(j => `${jobNames[j.type] || j.type}：${j.message || jobStatuses[j.status]}`).join(' · ');
  $$('[data-job]').forEach(button => { button.disabled = active.length > 0; });
  $('#jobList').innerHTML = jobs.length ? jobs.slice().sort((a,b) => (b.startedAt || b.createdAt || '').localeCompare(a.startedAt || a.createdAt || '')).map(j => `<article class="job-card"><div class="card-top"><h3>${escapeHTML(jobNames[j.type] || j.type)}</h3><span class="job-status ${escapeHTML(j.status)}">${escapeHTML(jobStatuses[j.status] || j.status)}</span></div><p>${escapeHTML(j.message || '')}</p>${typeof j.progress === 'number' ? `<progress max="100" value="${Math.max(0,Math.min(100,j.progress))}"></progress>` : ''}<div class="small-meta">开始 ${escapeHTML(timeLabel(j.startedAt))}${j.finishedAt ? ' · 结束 ' + escapeHTML(timeLabel(j.finishedAt)) : ''}</div>${j.errors?.length ? `<details class="job-errors"><summary>${j.errors.length} 项需要关注</summary>${j.errors.map(e => `<p>${textValue(e)}</p>`).join('')}</details>` : ''}</article>`).join('') : blank('还没有运行记录。点击上面的按钮开始更新。');
  $('#runtimeNotice').textContent = runtimeDescription();
  if (!settingsInitialized && state.settings) {
    const form = $('#settingsForm');
    form.elements.dailyEnabled.checked = Boolean(state.settings.dailyEnabled);
    form.elements.maxArticlesPerRun.value = state.settings.maxArticlesPerRun || 12;
    form.elements.maxRepoAnalysesPerRun.value = state.settings.maxRepoAnalysesPerRun || 3;
    form.elements.sourceArticleLimit.value = state.settings.sourceArticleLimit ?? 3;
    form.elements.collectionSinceDays.value = state.settings.collectionSinceDays ?? 30;
    settingsInitialized = true;
  }
  scheduleRefresh(active.length ? 3000 : 30000);
}
function textValue(value) { return escapeHTML(typeof value === 'string' ? value : value ? JSON.stringify(value) : ''); }
function modeLabel(mode) { return mode === 'codex' || mode === 'ai' || mode === 'openai' || mode === 'deepseek' ? 'AI 分析 · 请结合原文核对' : mode ? `分析方式：${escapeHTML(mode)} · 请结合原文核对` : '分析方式未标注 · 请结合原文核对'; }
function editQuestion(question) {
  editingQuestionId = question?.id || null;
  const form = $('#researchQuestionForm'); form.reset();
  $('#questionDialogTitle').textContent = question ? '编辑研究问题' : '添加研究问题';
  for (const name of ['title','notes','status','url']) form.elements[name].value = question?.[name] || (name === 'status' ? 'active' : '');
  form.querySelectorAll('[name=topics]').forEach(input => { input.checked = (question?.topics || ['ai']).includes(input.value); });
  $('#questionDialog').showModal();
}
for (const id of ['recommendSearch','recommendFilter','questionSearch']) $('#'+id).addEventListener('input',renderIntelligence);
$('#newQuestion').addEventListener('click',() => editQuestion(null));
document.addEventListener('click',async event => {
  const run = event.target.closest('[data-job]');
  const feedback = event.target.closest('[data-feedback]');
  const question = event.target.closest('[data-edit-question]');
  const blog = event.target.closest('[data-read-blog]');
  if (question) return editQuestion((state.questions || []).find(q => q.id === question.dataset.editQuestion));
  if (blog) {
    const entry = (state.blogs || []).find(b => b.id === blog.dataset.readBlog); if (!entry) return;
    $('#blogDetailTitle').textContent = entry.title; $('#blogDetailLink').innerHTML = safeLink(entry.url,'打开原文'); $('#blogDetailContent').textContent = entry.content; $('#blogDialog').showModal(); return;
  }
  if (!run && !feedback) return;
  const button = run || feedback; button.disabled = true;
  try {
    if (run) { await api('/api/jobs',{method:'POST',body:JSON.stringify({type:run.dataset.job,...(run.dataset.repository ? {repositoryId:run.dataset.repository} : {})})}); toast('任务已开始，可在“更新与任务”查看进度'); }
    else { await api('/api/recommendations/'+encodeURIComponent(feedback.dataset.recommendation),{method:'PATCH',body:JSON.stringify({feedback:feedback.dataset.feedback})}); toast('反馈已保存'); }
    await refresh();
  } catch(error) { toast(error.message); }
  finally { button.disabled = false; }
});
$('#researchQuestionForm').addEventListener('submit',async event => {
  event.preventDefault(); const form = event.currentTarget, data = new FormData(form), button = form.querySelector('[type=submit]'); button.disabled = true;
  const input = Object.fromEntries(data); input.topics = data.getAll('topics');
  try { await api(editingQuestionId ? '/api/questions/'+encodeURIComponent(editingQuestionId) : '/api/questions',{method:editingQuestionId ? 'PATCH':'POST',body:JSON.stringify(input)}); $('#questionDialog').close(); await refresh(); toast('研究问题已保存'); }
  catch(error) { toast(error.message); } finally { button.disabled = false; }
});
$('#settingsForm').addEventListener('submit',async event => {
  event.preventDefault(); const form = event.currentTarget, button = form.querySelector('[type=submit]'); button.disabled = true;
  try { await api('/api/settings',{method:'PATCH',body:JSON.stringify({...(state.runtime?.deployment==='cloud'?{}:{dailyEnabled:form.elements.dailyEnabled.checked}),sourceArticleLimit:Number(form.elements.sourceArticleLimit.value),collectionSinceDays:Number(form.elements.collectionSinceDays.value),maxArticlesPerRun:Number(form.elements.maxArticlesPerRun.value),maxRepoAnalysesPerRun:Number(form.elements.maxRepoAnalysesPerRun.value)})}); $('#settingsSaved').textContent = '已保存'; await refresh(); }
  catch(error) { toast(error.message); } finally { button.disabled = false; }
});
window.addEventListener('hashchange',() => showView(location.hash.slice(1) || 'inbox'));

function isCandidate(question) { return question.status === 'paused' && ['blog','repository'].includes(question.origin) && !question.humanEdited; }
function scheduleRefresh(delay) {
  clearTimeout(pollTimer);
  if (!$('#loginScreen').classList.contains('hidden')) return;
  pollTimer = setTimeout(async () => {
    try { await refresh(); $('#connectionNotice').classList.add('hidden'); }
    catch (error) { if (error.status === 401) return; $('#connectionNotice').textContent = '连接中断，正在自动重试。当前显示上次获取的内容。'; $('#connectionNotice').classList.remove('hidden'); scheduleRefresh(10000); }
  },delay);
}
window.addEventListener('online',() => scheduleRefresh(100));

let agentSettingsInitialized = false;
const agentStatusNames = { idle:'等待唤醒', planning:'判断下一步', working:'执行中', paused:'已暂停', error:'执行失败', budget_limited:'已达到运行上限' };
function runtimeDescription() {
  const runtime = state.runtime || {}, cloud = runtime.deployment === 'cloud';
  if (cloud) return runtime.available ? '当前运行于云端。任务结果和异常会记录在此，无需个人电脑保持在线。' : '当前为云端服务，分析模型尚未就绪。配置模型与运行预算后再开启持续运行。';
  if (runtime.provider === 'deepseek') return runtime.available ? '已配置 DeepSeek API，模型连通性与额度以实际任务为准。' : 'DeepSeek API 尚未配置完成，请检查密钥和模型。';
  if (runtime.provider === 'openai') return runtime.available ? '当前运行于本机，已配置 OpenAI API。服务需保持运行；模型连通性及额度以实际任务为准。' : '当前运行于本机，OpenAI API 尚未配置完成。请检查模型和密钥。';
  return runtime.available ? '当前运行于本机，已检测到 Codex CLI。服务需持续运行；实际分析还需有效登录，结果以任务记录为准。' : '当前运行于本机，分析服务尚未就绪。请检查 Codex CLI 的安装及登录状态。';
}
function showLogin() {
  clearTimeout(pollTimer);
  $$('.shell dialog[open], dialog[open]').forEach(dialog => dialog.close());
  $('.shell').classList.add('hidden'); $('#loginScreen').classList.remove('hidden');
  $('#loginPassword').focus();
}
function renderAgents() {
  $('#agentRuntime').textContent = runtimeDescription();
  const agents = state.agents || [], settings = state.agentSettings;
  const busy = agents.some(a => ['planning','working'].includes(a.status));
  $('#wakeAgents').disabled = !settings?.enabled || !state.runtime?.available || busy;
  if (!agentSettingsInitialized && settings) {
    const form = $('#agentSettingsForm');
    form.elements.enabled.checked = Boolean(settings.enabled);
    for (const [key,value] of Object.entries({checkIntervalHours:1,wakeIntervalHours:24,maxDecisionsPerDay:3,maxActionsPerDay:6})) form.elements[key].value = settings[key] ?? value;
    agentSettingsInitialized = true;
  }
  const openMemories = $$('#agentCards details[open]').map(d => d.dataset.agentMemory);
  const editingGoal = document.activeElement?.closest('.agent-goal-form');
  if (!editingGoal) $('#agentCards').innerHTML = agents.length ? agents.map(a => `<article class="profile-card"><div class="card-top"><h3>${escapeHTML(a.name)}</h3><span class="job-status ${a.status === 'error' ? 'failed' : ''}">${a.id === 'engineering' ? '手动执行' : escapeHTML(agentStatusNames[a.status] || a.status)}</span></div><form class="agent-goal-form" data-agent="${escapeHTML(a.id)}"><label>工作目标<textarea name="goal" rows="3" maxlength="2000" required>${escapeHTML(a.goal || '')}</textarea></label><button class="plain-link" type="submit">保存目标</button></form><p class="small-meta">上次唤醒：${escapeHTML(timeLabel(a.lastWakeAt))}${a.nextWakeAt && a.id !== 'engineering' ? '<br>下次计划：' + escapeHTML(timeLabel(a.nextWakeAt)) : ''}</p>${a.lastAction ? `<p><b>最近行动</b> ${escapeHTML(a.lastAction)}</p>` : ''}${a.lastReason ? `<p>${escapeHTML(a.lastReason)}</p>` : ''}${a.error ? `<p class="error-notice">${escapeHTML(a.error)}</p>` : ''}<details class="agent-memory" data-agent-memory="${escapeHTML(a.id)}"><summary>工作记忆</summary><pre>${escapeHTML(a.memory || '暂无工作记忆。执行完成后会记录可延续的进展。')}</pre></details>${a.id === 'engineering' ? '<p class="muted-copy">不定时检查仓库。请在“我的研究”手动同步或分析项目。</p>' : `<button class="button outline" data-toggle-agent="${escapeHTML(a.id)}">${a.enabled ? '暂停这个助手' : '启用这个助手'}</button>`}</article>`).join('') : blank('助手状态尚未提供。服务接入持续运行后，将显示目标、状态和工作记忆。');
  openMemories.forEach(id => $$('#agentCards details').find(d => d.dataset.agentMemory === id)?.setAttribute('open',''));
  $('#agentEventList').innerHTML = (state.agentEvents || []).slice().sort((a,b) => (b.at || '').localeCompare(a.at || '')).slice(0,50).map(e => `<article class="job-card"><div class="card-top"><h3>${escapeHTML(agents.find(a => a.id === e.agentId)?.name || e.agentId)}</h3><span class="small-meta">${escapeHTML(timeLabel(e.at))}</span></div><p>${escapeHTML(e.action || '')} · ${escapeHTML(agentStatusNames[e.status] || jobStatuses[e.status] || e.status || '')}</p><p>${escapeHTML(e.reason || '')}</p></article>`).join('') || blank('还没有行动记录。开启持续运行后，每次行动的判断依据会保存在这里。');
  if (busy) scheduleRefresh(3000);
}
$('#agentSettingsForm').addEventListener('submit',async event => {
  event.preventDefault(); const form=event.currentTarget,button=form.querySelector('[type=submit]'); button.disabled=true;
  const data={enabled:form.elements.enabled.checked};
  for(const key of ['checkIntervalHours','wakeIntervalHours','maxDecisionsPerDay','maxActionsPerDay']) data[key]=Number(form.elements[key].value);
  try { await api('/api/agent-settings',{method:'PATCH',body:JSON.stringify(data)}); await refresh(); toast('运行设置已保存'); } catch(error){toast(error.message);} finally{button.disabled=false;}
});
$('#agentCards').addEventListener('submit',async event => {
  const form=event.target.closest('.agent-goal-form'); if(!form)return; event.preventDefault(); const button=form.querySelector('[type=submit]'); button.disabled=true;
  try {await api('/api/agents/'+encodeURIComponent(form.dataset.agent),{method:'PATCH',body:JSON.stringify({goal:form.elements.goal.value,enabled:Boolean((state.agents || []).find(a=>a.id===form.dataset.agent)?.enabled)})});await refresh();toast('目标已保存');}catch(error){toast(error.message);}finally{button.disabled=false;}
});
$('#agentCards').addEventListener('click',async event => {
  const button=event.target.closest('[data-toggle-agent]');if(!button)return;
  const agent=(state.agents || []).find(a=>a.id===button.dataset.toggleAgent);if(!agent || agent.id==='engineering')return;button.disabled=true;
  try{await api('/api/agents/'+encodeURIComponent(agent.id),{method:'PATCH',body:JSON.stringify({enabled:!agent.enabled})});await refresh();toast(agent.enabled?'助手已暂停':'助手已启用');}catch(error){toast(error.message);}finally{button.disabled=false;}
});
$('#wakeAgents').addEventListener('click',async event => {
  const button=event.currentTarget;button.disabled=true;
  try{await api('/api/agents/wake',{method:'POST',body:'{}'});await refresh();toast('已提交唤醒请求，请查看实际行动记录');}catch(error){toast(error.message);}finally{button.disabled=!(state.agentSettings?.enabled && state.runtime?.available) || (state.agents || []).some(a=>['planning','working'].includes(a.status));}
});
$('#loginForm').addEventListener('submit',async event => {
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;$('#loginError').classList.add('hidden');
  try{await api('/api/login',{method:'POST',body:JSON.stringify({password:form.elements.password.value})});form.reset();await refresh();}
  catch(error){$('#loginError').textContent=error.message;$('#loginError').classList.remove('hidden');}
  finally{button.disabled=false;}
});
$('#logoutButton').addEventListener('click',async () => {
  try{await api('/api/logout',{method:'POST',body:'{}'});state={items:[],answers:[],sources:[]};settingsInitialized=false;agentSettingsInitialized=false;showLogin();}catch(error){toast(error.message);}
});
