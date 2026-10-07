import { runStructured } from '#analysis-provider';
export { runStructured, runtimeStatus, configuredModel, analysisProvider } from '#analysis-provider';
const string = {type:'string'};
const strings = {type:'array',items:string};
const object = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const articleSchema = object({results:{type:'array',items:object({id:string,summary:string,topics:{type:'array',items:{type:'string',enum:['ai','game','backend']}},problem:string,method:string,conclusion:string,rationale:string,recommend:{type:'boolean'},relations:{type:'array',items:object({referenceId:string,reason:string})}})}});
const repoSchema = object({problem:string,viewpoint:string,approach:string,tradeoffs:string,validation:string,inference:{type:'boolean'},evidencePaths:strings,questions:strings});
const blogSchema = object({results:{type:'array',items:object({id:string,summary:string,topics:{type:'array',items:{type:'string',enum:['ai','game','backend']}},questions:strings})}});
export const ANALYSIS_VERSION = 'personal-v1';
const text=(value,max=1600)=>typeof value==='string'?value.trim().slice(0,max):'';
const topics=value=>Array.isArray(value)?[...new Set(value.filter(v=>['ai','game','backend'].includes(v)))]:[];
export function referenceContext(store,query='') {
  const terms=[...new Set(query.toLowerCase().match(/[a-z0-9_]{3,}|[\p{Script=Han}]{2,4}/gu)||[])];
  const refs=[
    ...store.questions.filter(q=>q.status==='active').map(q=>({referenceId:'question:'+q.id,kind:'question',id:q.id,title:q.title,url:q.url||'',text:q.notes||''})),
    ...store.blogs.map(b=>({referenceId:'blog:'+b.id,kind:'blog',id:b.id,title:b.title,url:b.url,text:b.summary||b.content.slice(0,1800)})),
    ...store.repositories.filter(r=>!r.fork&&r.card).map(r=>({referenceId:'repository:'+r.id,kind:'repository',id:r.id,title:r.name,url:r.url,text:JSON.stringify(r.card).slice(0,2200)})),
  ];
  const score=ref=>terms.reduce((n,t)=>n+(ref.title.toLowerCase().includes(t)?4:0)+(ref.text.toLowerCase().includes(t)?1:0),ref.kind==='question'?2:0);
  return refs.sort((a,b)=>score(b)-score(a)).slice(0,40);
}
export async function analyzeArticles(articles,store,runner=runStructured) {
  const refs=referenceContext(store,articles.map(a=>a.title+' '+(a.excerpt||a.summary||'').slice(0,800)).join(' '));
  const result=await runner('逐篇判断技术价值，生成短摘要、问题/方法/结论和入选评语。主题限 AI、游戏开发、服务端。只在提供材料足够支持具体技术价值时 recommend=true；营销、纯商业新闻、只有模糊标题的条目不要推荐。优先匹配正在研究的问题、博客及代码实践，relations 只能使用给定 referenceId，解释具体关联。没有真实关联就留空，不要硬凑；仍有明确技术价值的文章可以作为探索推荐。已解决问题不视为正在研究。外部摘要不超过200个汉字，三项结构化信息各不超过100字。反馈中的无关例子用于减少同类推荐，但不是禁止整个领域。', {articles:articles.map(a=>({id:a.id,title:a.title,url:a.url,excerpt:a.excerpt||a.summary||'',topics:a.topics,sourceName:a.sourceName})),references:refs,resolvedQuestions:store.questions.filter(q=>q.status==='resolved').map(q=>({title:q.title,notes:q.notes})).slice(0,30),feedback:store.recommendations.filter(r=>r.feedback!=='new').sort((a,b)=>(b.feedbackAt||'').localeCompare(a.feedbackAt||'')).slice(0,20).map(r=>({title:r.title,feedback:r.feedback,rationale:r.rationale}))},articleSchema);
  if(!Array.isArray(result.results))throw new Error('文章分析格式无效');
  return articles.map(article=>{
    const r=result.results.find(r=>r.id===article.id);if(!r||typeof r.recommend!=='boolean'||!text(r.summary)||!text(r.rationale))throw new Error('文章分析缺少必要字段');
    return {id:article.id,summary:text(r.summary,600),topics:topics(r.topics),problem:text(r.problem,300),method:text(r.method,300),conclusion:text(r.conclusion,300),rationale:text(r.rationale,1000),recommend:r.recommend,relations:(Array.isArray(r.relations)?r.relations:[]).flatMap(link=>{const ref=refs.find(v=>v.referenceId===link.referenceId);return ref?[{kind:ref.kind,id:ref.id,title:ref.title,url:ref.url,reason:text(link.reason,500)}]:[];})};
  });
}
export async function analyzeRepository(repository,evidence,runner=runStructured) {
  const r=await runner('为整个仓库生成一张工程观点卡。基于所给文件说清目标、观点、做法、取舍、验证结果。没有测试运行证据时不能声称测试通过。设计动机不明确时 inference=true。evidencePaths 只能选给定文件路径；缺少实现时说明仅有文档证据。提出至多3个值得用户继续研究的候选问题。', {repository,evidence},repoSchema);
  if(!text(r.problem)||!text(r.viewpoint)||!Array.isArray(r.evidencePaths))throw new Error('仓库分析格式无效');
  if(!evidence.files.some(f=>r.evidencePaths.includes(f.path)))throw new Error('仓库分析未提供有效的代码或文档依据');
  return {card:{problem:text(r.problem),viewpoint:text(r.viewpoint),approach:text(r.approach),tradeoffs:text(r.tradeoffs),validation:text(r.validation),inference:r.inference!==false,evidence:evidence.files.filter(f=>r.evidencePaths.includes(f.path)).map(({path,url})=>({path,url}))},questions:(r.questions||[]).map(q=>text(q,200)).filter(Boolean).slice(0,3)};
}
export async function analyzeBlogs(blogs,runner=runStructured) {
  const result=await runner('概括用户博客的研究主题，提取至多2个尚值得研究的问题作为待用户确认的候选。不因文章提到某术语就断言作者正在研究它。每篇摘要不超过200字，questions 只返回问题文本。', {blogs:blogs.map(b=>({id:b.id,title:b.title,content:b.content.slice(0,10000)}))},blogSchema);
  if(!Array.isArray(result.results))throw new Error('博客分析格式无效');
  return blogs.map(b=>{const r=result.results.find(r=>r.id===b.id);if(!r||!text(r.summary))throw new Error('博客分析缺少摘要');return {id:b.id,summary:text(r.summary,600),topics:topics(r.topics),questions:(r.questions||[]).map(q=>text(q,200)).filter(Boolean).slice(0,2)};});
}
