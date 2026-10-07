export function knowledgeItems(store){
  return [
    ...store.items,
    ...store.blogs.map(b=>({id:'derived:'+b.id,title:b.title,category:'writing',source:b.url,content:b.content,createdAt:b.updatedAt||b.publishedAt||b.analyzedAt||new Date(0).toISOString(),readOnly:true})),
    ...store.articles.map(a=>({id:'derived:'+a.id,title:a.title,category:'research',source:a.url,content:[a.summary,`推荐理由：${a.rationale}`,`问题：${a.problem||'未明确'}`,`方法：${a.method||'未明确'}`,`结论：${a.conclusion||'未明确'}`].join('\n\n'),createdAt:a.createdAt,readOnly:true})),
    ...store.repositories.filter(r=>!r.fork&&r.card).map(r=>({id:'derived:'+r.id,title:r.name+' · 工程观点',category:'engineering',source:r.url,content:[`观点（${r.card.inference?'推断':'资料中明确记录'}）：${r.card.viewpoint}`,`问题：${r.card.problem}`,`做法：${r.card.approach}`,`取舍：${r.card.tradeoffs}`,`验证：${r.card.validation}`,...r.card.evidence.map(e=>`${e.path}: ${e.url}`)].join('\n\n'),createdAt:r.analyzedAt,readOnly:true})),
  ].map(item=>({...item,createdAt:new Date(item.createdAt).toString()==='Invalid Date'?new Date(0).toISOString():new Date(item.createdAt).toISOString()}));
}
