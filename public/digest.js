export const digestGroups = [['research','个人研究／工程作者'],['news','新闻／技术通讯'],['official','官方研究／工程']];

export function selectDigest(recommendations, limit = 5, options = {}) {
  const eligible = recommendations.filter(item => !item.stale && !['irrelevant','known','useful'].includes(item.feedback) && /^ai-reading-v[12]$/.test(item.analysisVersion) && (item.qualityScore ?? 70) >= 70);
  const latest = eligible.map(item => (item.updatedAt || item.createdAt || '').slice(0,10)).sort().at(-1);
  const ranked = eligible.filter(item => options.all || (item.updatedAt || item.createdAt || '').slice(0,10) === latest).sort((left,right) => (right.qualityScore || 0) - (left.qualityScore || 0) || (right.updatedAt || right.createdAt || '').localeCompare(left.updatedAt || left.createdAt || ''));
  const events = new Set();
  return ranked.filter(item => {
    const key = item.eventKey?.trim().toLowerCase() || item.url;
    if (events.has(key)) return false;
    events.add(key);
    return true;
  }).slice(0, limit);
}

export function sourceFor(item, sources = []) {
  return sources.find(source => item.sourceId && source.id === item.sourceId) || sources.find(source => item.sourceName && source.name === item.sourceName);
}

export function readingDecision(store) {
  const sources = store.sources || [];
  const articles = store.articles || [];
  const recommendations = (store.recommendations || []).map(item => {
    const article=articles.find(article => article.id === item.articleId);
    return {...article,...item,sourceId:item.sourceId||article?.sourceId,sourceName:item.sourceName||article?.sourceName};
  });
  const allowed = recommendations.filter(item => sourceFor(item,sources)?.enabled !== false);
  const jobs = (store.jobs || []).filter(job => ['daily','collect','recommend'].includes(job.type)).sort((left,right) => (right.startedAt || right.createdAt || '').localeCompare(left.startedAt || left.createdAt || ''));
  const latest = jobs[0];
  const start = Date.parse(latest?.startedAt || latest?.createdAt);
  const end = Date.parse(latest?.finishedAt);
  const inRound = item => item.jobId ? item.jobId === latest?.id : Number.isFinite(start) && Number.isFinite(end) && Date.parse(item.updatedAt || item.createdAt) >= start && Date.parse(item.updatedAt || item.createdAt) <= end;
  const candidates = latest ? allowed.filter(inRound) : allowed;
  const active = latest && ['queued','running'].includes(latest.status);
  const digest = active ? [] : selectDigest(candidates,5,{all:Boolean(latest)});
  const failed = latest && ['failed','interrupted'].includes(latest.status);
  const partial = latest?.status === 'partial';
  let status = active ? 'running' : failed ? 'failed' : partial ? 'partial' : digest.length ? 'ready' : 'empty';
  if (!latest && !digest.length) status = allowed.some(item => !/^ai-reading-v[12]$/.test(item.analysisVersion)) ? 'needs_analysis' : 'not_started';
  if (latest?.status === 'success' && !digest.length && candidates.some(item => !/^ai-reading-v[12]$/.test(item.analysisVersion))) status = 'needs_analysis';
  const checked = latest?.type !== 'recommend' ? sources.filter(source => source.enabled && Number.isFinite(start) && Date.parse(source.lastCollection?.at) >= start && (!Number.isFinite(end) || Date.parse(source.lastCollection?.at) <= end)) : [];
  return {status,digest,latest,checked:checked.length,failures:checked.filter(source => source.lastCollection?.status === 'error').length,errorCount:latest?.errors?.length || 0,history:recommendations,disabledCount:recommendations.filter(item => sourceFor(item,sources)?.enabled === false).length};
}
