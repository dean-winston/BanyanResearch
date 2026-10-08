import {readingDecision,sourceFor} from './digest.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '尚未运行';
const link = (url,title) => {try{const address=new URL(url);if(['https:','http:'].includes(address.protocol))return `<a href="${escape(address.href)}" target="_blank" rel="noopener noreferrer">${escape(title)} ↗</a>`;}catch{}return escape(title);};
export const feedbackReasons = {depth:'内容太浅',duplicate:'内容重复',evidence:'缺少技术证据',topic:'主题不感兴趣',source:'不信任这个来源'};
const feedbackLabels = {new:'未处理',useful:'有用',irrelevant:'不相关',known:'已了解',later:'稍后看'};

function feedback(item) {
  return `<div class="feedback-actions" aria-label="推荐反馈">${Object.entries(feedbackLabels).filter(([value])=>value!=='new').map(([value,label])=>`<button class="feedback-button ${item.feedback===value?'selected':''}" data-feedback="${value}" data-recommendation="${escape(item.id)}" aria-pressed="${item.feedback===value}">${label}</button>`).join('')}${item.feedback&&item.feedback!=='new'?`<button class="plain-link" data-feedback="new" data-recommendation="${escape(item.id)}">撤销反馈</button>`:''}</div><label class="reading-feedback-reason">反馈原因（可选）<select data-feedback-reason="${escape(item.id)}" aria-label="${escape(item.title)}的反馈原因"><option value="">不补充原因</option>${Object.entries(feedbackReasons).map(([value,label])=>`<option value="${value}" ${item.feedbackReason===value?'selected':''}>${label}</option>`).join('')}</select></label>`;
}

export function readingCard(item, {featured=false,history=false,sources=[]} = {}) {
  const disabled=sourceFor(item,sources)?.enabled===false;
  const scope=item.readingScope==='original_full'?'dots 声明已阅读原文，结论仍需核验':item.readingScope==='original_excerpt'?'基于原文片段，非全文核验':item.readingScope==='saved_summary'?'基于已保存摘要，未重新核验原文':'原文阅读未确认，仅供线索参考';
  const technicalGain=item.technicalGain||item.method||'尚未提炼具体方法；需进一步核对原文。';
  const evidence=item.evidence||'未单独记录实验证据；不据此认定结论已验证。';
  const limitations=item.limitations||'适用条件和局限尚未提炼，请结合原文判断。';
  return `<article class="recommend-card reading-card ${featured?'reading-featured':''} ${history?'reading-history-card':''}"><div class="card-top"><span class="reading-badge">${featured?'最值得先读':history?'历史记录':'值得关注'}</span><span class="small-meta">${escape(item.sourceKind||'来源性质待核对')}</span></div><h${featured?'2':'3'}>${link(item.url,item.title)}</h${featured?'2':'3'}><div class="small-meta">${escape(item.sourceName||'未知来源')} · ${item.publishedAt?escape(date(item.publishedAt)):'发表日期未知'}</div>${disabled?'<p class="reading-warning">来源已停用，仅保留历史记录，不进入当前精选。</p>':''}${item.stale?`<p class="reading-warning">${escape(item.staleReason||'重新分析后未入选')}</p>`:''}<p class="reading-summary">${escape(item.summary)}</p><dl class="reading-judgment"><div><dt>技术增量</dt><dd>${escape(technicalGain)}</dd></div><div><dt>阅读收益</dt><dd>${escape(item.rationale||'尚未记录具体阅读收益')}</dd></div><div><dt>证据与可信度</dt><dd>${escape(evidence)}<small>${scope}</small></dd></div><div><dt>局限与适用条件</dt><dd>${escape(limitations)}</dd></div></dl>${item.relations?.length?`<details class="reading-relations"><summary>与你的研究关联 · ${item.relations.length} 条</summary>${item.relations.map(relation=>`<p>${link(relation.url,relation.title)}<br>${escape(relation.reason)}</p>`).join('')}</details>`:''}${history?`<p class="small-meta">反馈：${escape(feedbackLabels[item.feedback||'new'])}${item.feedbackReason?' · '+escape(feedbackReasons[item.feedbackReason]||item.feedbackReason):''}</p>`:''}${feedback(item)}</article>`;
}

export function renderReadingDecision(store) {
  const decision=readingDecision(store);
  const titles={awaiting_dots:'新线索已准备好，等待 dots 研究',running:'正在形成本轮阅读判断',failed:'本轮更新未完成，不能据此判断没有好内容',partial:'本轮覆盖不完整，先看已确认的内容',ready:`本轮值得读 ${decision.digest.length} 条，先读这一篇`,empty:'本轮暂不推荐：没有新的合格入选内容',needs_analysis:'历史推荐尚未按当前阅读标准整理',not_started:'还没有形成阅读判断'};
  const descriptions={awaiting_dots:'到 dots 对话中运行研究任务，写回后将在这里展示精选。',running:'任务完成后再形成精选，不把旧推荐当成本轮结果。',failed:'请查看任务错误并重试，历史记录仍然保留。',partial:'部分来源或分析失败。下面只是已完成部分，不代表完整覆盖。',ready:'按技术价值排序，最多保留 5 条；不是必须清空的待办清单。',empty:'可能没有新候选，或候选未达到推荐标准。不为凑数推荐。',needs_analysis:'可用现有摘要重新整理；不会声称重新读过原文。',not_started:'采集并分析后，给出首选、阅读收益与证据边界。'};
  const actions=decision.status==='running'?'':`<button class="button dark" data-job="collect">${decision.status==='failed'?'重试采集':'更新阅读线索'}</button>${decision.history.length?'<button class="button outline" data-job="recommend">重新整理历史</button>':''}`;
  const coverage=decision.latest?`最近任务：${escape(date(decision.latest.finishedAt||decision.latest.startedAt||decision.latest.createdAt))}${decision.latest.type==='recommend'?' · 基于已有摘要重新整理':decision.checked?` · 本轮检查 ${decision.checked} 个来源，${decision.failures} 个失败`:' · 尚无本轮来源覆盖记录'}${decision.errorCount?` · ${decision.errorCount} 项任务异常`:''}`:'尚未运行阅读采集任务';
  const header=`<section class="reading-verdict" aria-labelledby="readingVerdictTitle"><div class="eyebrow muted">YOUR READING DECISION</div><h2 id="readingVerdictTitle">${titles[decision.status]}</h2><p>${descriptions[decision.status]}</p><div class="small-meta">${coverage}</div><div class="reading-actions">${actions}<button class="plain-link" data-reading-view="tasks">查看任务详情 →</button></div></section>`;
  const cards=decision.digest.map((item,index)=>readingCard(item,{featured:index===0,sources:store.sources}));
  const followup=cards.length>1?`<section class="reading-followup"><div class="reading-section-heading"><h2>值得关注</h2><span class="small-meta">${cards.length-1} 条补充，不必全部阅读</span></div><div class="reading-grid">${cards.slice(1).join('')}</div></section>`:'';
  const questions=[...new Map(decision.digest.filter(item=>item.researchQuestion).map(item=>[item.researchQuestion.trim(),item])).values()].slice(0,3);
  const exploration=questions.length?`<section class="reading-exploration"><h2>值得深挖的问题</h2><p class="small-meta">阅读延伸，不会自动加入正在研究的问题。</p>${questions.map(item=>`<div><h3>${escape(item.researchQuestion)}</h3><p class="small-meta">来自 ${link(item.url,item.title)}</p></div>`).join('')}</section>`:'';
  return {html:header+(cards[0]||'')+followup+exploration,decision};
}
