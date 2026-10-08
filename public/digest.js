export const digestGroups = [['research','个人研究／工程作者'],['news','新闻／技术通讯'],['official','官方研究／工程']];

export function selectDigest(recommendations, limit = 5) {
  const eligible = recommendations.filter(item => !item.stale && !['irrelevant','known'].includes(item.feedback) && item.analysisVersion === 'ai-reading-v1');
  const latest = eligible.map(item => (item.createdAt || '').slice(0,10)).sort().at(-1);
  const ranked = eligible.filter(item => (item.createdAt || '').slice(0,10) === latest).sort((left,right) => (right.qualityScore || 0) - (left.qualityScore || 0));
  const events = new Set();
  return ranked.filter(item => {
    const key = item.eventKey?.trim().toLowerCase() || item.url;
    if (events.has(key)) return false;
    events.add(key);
    return true;
  }).slice(0, limit);
}
