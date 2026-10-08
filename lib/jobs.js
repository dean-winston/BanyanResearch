import crypto from 'node:crypto';
import {readStore,updateStore} from '#knowledge-store';
import {collectSource} from './collect.js';
import {readingSourceOrder} from './reading.js';
import {syncBlog,syncRepositories,getRepositoryEvidence} from './profile.js';
import {analyzeArticles,analyzeBlogs,analyzeRepository,ANALYSIS_VERSION,configuredModel,analysisProvider} from './analyzer.js';
const now=()=>new Date().toISOString();
const uid=(prefix,value)=>prefix+crypto.createHash('sha256').update(value).digest('hex').slice(0,24);
export function canonicalUrl(value){const url=new URL(value);if(!['http:','https:'].includes(url.protocol))throw new Error('文章网址无效');url.hash='';for(const key of [...url.searchParams.keys()])if(/^(utm_|fbclid|gclid)/i.test(key))url.searchParams.delete(key);url.searchParams.sort();return url.href.replace(/\/$/,'');}
function profileFingerprint(store){return crypto.createHash('sha256').update(JSON.stringify({analysisVersion:ANALYSIS_VERSION,questions:store.questions,blogs:store.blogs.map(b=>[b.id,b.sha,b.summary]),repositories:store.repositories.map(r=>[r.id,r.sha,r.card]),feedback:store.recommendations.filter(r=>r.feedback!=='new').map(r=>[r.id,r.feedback])})).digest('hex');}
const errorText=error=>(error?.message || String(error)).slice(0,500);
export function saveAnalyzedArticles(store,candidates,analyses){
  let added=0;
  for(const analysis of analyses){
    const candidate=candidates.find(a=>a.id===analysis.id);if(!candidate)continue;
    // Explicit allowlist: external excerpts and full bodies never enter persistent storage.
    const article={id:candidate.id,title:candidate.title,url:candidate.url,sourceId:candidate.sourceId,sourceName:candidate.sourceName,sourceGroup:candidate.sourceGroup,sourceKind:candidate.sourceKind,readingScope:analysis.readingScope||candidate.readingScope,readingError:candidate.readingError,qualityScore:analysis.qualityScore,eventKey:analysis.eventKey,publishedAt:candidate.publishedAt||'',createdAt:now(),summary:analysis.summary,topics:analysis.topics,problem:analysis.problem,method:analysis.method,conclusion:analysis.conclusion,rationale:analysis.rationale,analysisVersion:ANALYSIS_VERSION,analysisMode:analysisProvider,analysisModel:configuredModel||'CLI default',analyzedAt:now(),recommend:analysis.recommend};
    const old=store.articles.find(a=>a.id===article.id);
    if(old)Object.assign(old,{...article,createdAt:old.createdAt});else{store.articles.unshift(article);added++;}
    const existing=store.recommendations.find(r=>r.articleId===article.id);
    if(analysis.recommend){
      const recommendation={id:existing?.id||uid('rec-',article.id),articleId:article.id,title:article.title,url:article.url,summary:article.summary,rationale:article.rationale,topics:article.topics,sourceName:article.sourceName,sourceGroup:article.sourceGroup,sourceKind:article.sourceKind,publishedAt:article.publishedAt,readingScope:article.readingScope,qualityScore:article.qualityScore,eventKey:article.eventKey,relations:analysis.relations,feedback:existing?.feedback||'new',createdAt:existing?.createdAt||now(),updatedAt:now(),analysisMode:analysisProvider,analysisModel:configuredModel||'CLI default',analysisVersion:ANALYSIS_VERSION,stale:false,staleReason:''};
      if(existing)Object.assign(existing,recommendation);else store.recommendations.unshift(recommendation);
    }else if(existing){existing.stale=true;existing.staleReason='重新分析后未入选，保留原有反馈';}
  }
  return added;
}
export function addQuestionCandidates(store,questions,origin,url,topics){
  const previous=store.questions.filter(q=>q.origin===origin&&q.url===url&&!q.superseded);
  const retained=new Set();
  for(const [index,title] of questions.entries()){
    const existing=previous.find(q=>q.candidateSlot===index)||previous[index];
    if(existing){
      retained.add(existing.id);
      // Human-confirmed or edited questions are never replaced by a later extraction.
      if(existing.humanEdited||existing.status!=='paused')continue;
      Object.assign(existing,{title,topics:topics||[],candidateSlot:index,updatedAt:now()});
      continue;
    }
    if(store.questions.some(q=>q.title===title&&!q.superseded))continue;
    store.questions.push({id:crypto.randomUUID(),title,notes:'Agent 提取的候选问题，请确认后设为“正在研究”。',status:'paused',topics:topics||[],origin,url,candidateSlot:index,createdAt:now(),updatedAt:now()});
  }
  for(const old of previous)if(!retained.has(old.id)&&!old.humanEdited&&old.status==='paused')old.superseded=true;
}
export function createJobRunner(dependencies={}){
 const deps={collectionConcurrency:4,collectSource,syncBlog,syncRepositories,getRepositoryEvidence,analyzeArticles,analyzeBlogs,analyzeRepository,...dependencies};
 let queue=Promise.resolve(), pending=new Map();
 async function progress(id,message,value){await updateStore(s=>{const j=s.jobs.find(j=>j.id===id);if(j){j.message=message;if(value!==undefined)j.progress=value;}});}
 async function warn(id,message){await updateStore(s=>{const j=s.jobs.find(j=>j.id===id);if(j&&j.errors.length<100)j.errors.push(message.slice(0,600));});}
 async function blog(id){
   await progress(id,'正在同步博客全文…',5);
   const result=await deps.syncBlog();for(const warning of result.warnings||[])await warn(id,String(warning));
   const changed=await updateStore(store=>{const changed=[];for(const article of result.articles){const old=store.blogs.find(b=>b.id===article.id);if(!old||old.sha!==article.sha||!old.summary||old.analyzedSha!==article.sha){changed.push(article);if(old)Object.assign(old,article,{summary:'',analysisStatus:'pending'});else store.blogs.push({...article,analysisStatus:'pending'});}}return changed;});
   for(let index=0;index<changed.length;index+=4){await progress(id,`博客已同步，分析研究主题 ${index+1}–${Math.min(index+4,changed.length)} / ${changed.length}`,15+Math.round(index/Math.max(changed.length,1)*60));
     try{const analyses=await deps.analyzeBlogs(changed.slice(index,index+4));await updateStore(s=>{for(const a of analyses){const b=s.blogs.find(b=>b.id===a.id);if(!b)continue;b.summary=a.summary;b.topics=a.topics;b.analysisStatus='success';b.analyzedSha=b.sha;b.analyzedAt=now();b.analysisModel=configuredModel||'CLI default';b.analysisVersion=ANALYSIS_VERSION;addQuestionCandidates(s,a.questions,'blog',b.url,a.topics);}});}catch(error){await warn(id,'博客主题分析：'+errorText(error));break;}
   }
   await progress(id,`同步 ${result.articles.length} 篇博客，${changed.length} 篇需要更新分析`,80);
 }
 async function repositories(id,repositoryId){
   if(!repositoryId){await progress(id,'正在枚举全部公开仓库…',5);const result=await deps.syncRepositories();for(const w of result.warnings||[])await warn(id,String(w));await updateStore(s=>{for(const repo of result.repositories){const old=s.repositories.find(r=>r.id===repo.id);if(old)Object.assign(old,repo);else s.repositories.push({...repo,analysisStatus:repo.fork?'excluded':'pending'});}});}
   const store=await readStore();
   const selected=store.repositories.filter(r=>!r.fork&&(repositoryId?r.id===repositoryId:r.analysisStatus!=='success')).sort((a,b)=>(a.analysisStatus==='failed')-(b.analysisStatus==='failed')||(a.lastAttemptAt||'').localeCompare(b.lastAttemptAt||'')).slice(0,store.settings.maxRepoAnalysesPerRun);
   if(repositoryId&&!selected.length)throw new Error('仓库不存在或是 Fork，不能分析为个人观点');
   for(let i=0;i<selected.length;i++){
     const repo=selected[i];await progress(id,`分析仓库 ${i+1}/${selected.length}：${repo.name}`,10+Math.round(i/Math.max(selected.length,1)*80));
     await updateStore(s=>{const r=s.repositories.find(r=>r.id===repo.id);r.analysisStatus='running';r.lastAttemptAt=now();});
     try{const evidence=await deps.getRepositoryEvidence(repo);if(!evidence.files.length)throw new Error('仓库没有足够的可读证据');const result=await deps.analyzeRepository(repo,evidence);await updateStore(s=>{const r=s.repositories.find(r=>r.id===repo.id);Object.assign(r,{...result,questions:undefined,sha:evidence.sha,analyzedAt:now(),analysisModel:configuredModel||'CLI default',analysisVersion:ANALYSIS_VERSION,analysisStatus:'success',analysisError:'',warnings:evidence.warnings||[]});addQuestionCandidates(s,result.questions,'repository',repo.url,[]);});}
     catch(error){await updateStore(s=>{const r=s.repositories.find(r=>r.id===repo.id);r.analysisStatus='failed';r.analysisError=errorText(error);});await warn(id,repo.name+'：'+errorText(error));}
   }
   const end=await readStore();const remaining=end.repositories.filter(r=>!r.fork&&r.analysisStatus!=='success').length;
   await progress(id,`已处理 ${selected.length} 个仓库；还有 ${remaining} 个待分析或需重试。Fork 仅保留清单。`,95);
 }
 async function collect(id){
   const store=await readStore(),sources=readingSourceOrder(store.sources.filter(s=>s.enabled));let scanned=0;const pools=[];
   for(let start=0;start<sources.length;start+=deps.collectionConcurrency){
     await Promise.all(sources.slice(start,start+deps.collectionConcurrency).map(async source=>{
       let result;try{result=await deps.collectSource(source,{limit:store.settings.sourceArticleLimit,sinceDays:store.settings.collectionSinceDays});}catch(error){result={status:'error',articles:[],error:errorText(error)};}
       if(result.status==='error')await warn(id,source.name+'：'+(result.error||'采集失败'));
       await updateStore(s=>{const target=s.sources.find(x=>x.id===source.id);if(target){target.lastCollection={status:result.status,at:now(),count:result.articles.length,error:result.error||''};if(result.feedUrl&&!target.feedUrl)target.feedUrl=result.feedUrl;target.checkedAt=now();target.verification=result.status==='error'?'采集失败，见最近结果':result.feedUrl?'订阅采集已验证':'网页采集已验证';target.httpStatus='';}});
       pools[sources.indexOf(source)] =result.articles.map(a=>({...a,sourceId:source.id,sourceName:source.name,sourceGroup:source.sourceGroup,sourceKind:source.sourceKind,sourceNotes:[source.notes,source.readingNotes].filter(Boolean).join('；')}));scanned++;await progress(id,`已检查 ${scanned}/${sources.length} 个信息源`,Math.round(scanned/Math.max(sources.length,1)*40));
     }));
   }
   const latest=await readStore(),urls=new Set(latest.articles.map(a=>a.url)),titles=new Set(latest.articles.map(a=>a.title.toLowerCase().replace(/\s+/g,' ').trim())),candidates=[];
   // Round-robin selection keeps one high-volume feed from occupying the entire budget.
   for(let index=0;index<store.settings.sourceArticleLimit;index++)for(const pool of pools){const a=pool[index];if(!a)continue;try{const url=canonicalUrl(a.url),title=(a.title||'').trim().slice(0,500),key=title.toLowerCase().replace(/\s+/g,' ');if(!title||urls.has(url)||titles.has(key))continue;urls.add(url);titles.add(key);candidates.push({...a,title,url,id:uid('article-',url)});}catch{}}
   const selected=candidates.slice(0,store.settings.maxArticlesPerRun);let added=0,attempted=0;
   for(let i=0;i<selected.length;i+=5){await progress(id,`分析外部文章 ${i+1}–${Math.min(i+5,selected.length)} / ${selected.length}`,45+Math.round(i/Math.max(selected.length,1)*45));
     try{const group=selected.slice(i,i+5);attempted+=group.length;const context=await readStore(),version=profileFingerprint(context),analyses=await deps.analyzeArticles(group,context);added+=await updateStore(s=>{const count=saveAnalyzedArticles(s,group,analyses);for(const article of s.articles)if(group.some(g=>g.id===article.id))article.recommendationVersion=version;return count;});}
     catch(error){await warn(id,'文章分析：'+errorText(error));break;}
   }
   await progress(id,`检查 ${sources.length} 个来源，新入库 ${added} 篇；${Math.max(0,candidates.length-selected.length)} 篇候选本轮未分析，后续需重新发现`,95);
   return attempted;
 }
 async function recommend(id,limit){
   const store=await readStore();const profileVersion=profileFingerprint(store);
   const articles=store.articles.filter(a=>a.recommendationVersion!==profileVersion).slice(0,limit ?? store.settings.maxArticlesPerRun);
   let completed=0;
   for(let i=0;i<articles.length;i+=5){await progress(id,`结合个人资料重新匹配 ${i+1}–${Math.min(i+5,articles.length)} / ${articles.length}`,10+Math.round(i/Math.max(articles.length,1)*80));const group=articles.slice(i,i+5);try{const analyses=await deps.analyzeArticles(group,await readStore());await updateStore(s=>{saveAnalyzedArticles(s,group,analyses);for(const a of s.articles)if(group.some(g=>g.id===a.id))a.recommendationVersion=profileVersion;});completed+=group.length;}catch(error){await warn(id,errorText(error));break;}}
   await progress(id,articles.length?`完成 ${completed}/${articles.length} 篇文章的关联检查`:'没有需要重新匹配的文章',95);
 }
 async function execute(job){
   await updateStore(s=>{const j=s.jobs.find(j=>j.id===job.id);j.status='running';j.startedAt=now();});
   try{
     if(job.type==='daily'){try{await blog(job.id);}catch(error){await warn(job.id,'博客同步：'+errorText(error));}const budget=(await readStore()).settings.maxArticlesPerRun;const used=await collect(job.id);if(used<budget)await recommend(job.id,budget-used);}
     else if(job.type==='blog')await blog(job.id);
     else if(job.type==='repositories')await repositories(job.id,job.repositoryId);
     else if(job.type==='collect')await collect(job.id);
     else await recommend(job.id);
     await updateStore(s=>{const j=s.jobs.find(j=>j.id===job.id);j.status=j.errors.length?'partial':'success';j.finishedAt=now();j.progress=100;if(job.type==='daily'&&!j.errors.length)s.settings.lastDailySuccessAt=now();});
   }catch(error){await updateStore(s=>{const j=s.jobs.find(j=>j.id===job.id);j.status='failed';j.message=errorText(error);j.errors.push(errorText(error));j.finishedAt=now();});}
 }
 async function enqueue(type,repositoryId){
   if(!['daily','collect','blog','repositories','recommend'].includes(type))throw Object.assign(new Error('任务类型无效'),{status:400});
   if(repositoryId&&(type!=='repositories'||typeof repositoryId!=='string'||repositoryId.length>200))throw Object.assign(new Error('仓库任务参数无效'),{status:400});
   const key=type+':'+(repositoryId||'');if(pending.has(key))return pending.get(key);
   const job={id:crypto.randomUUID(),type,repositoryId,status:'queued',createdAt:now(),startedAt:'',finishedAt:'',progress:0,message:'等待执行',errors:[]};
   pending.set(key,job);
   try{await updateStore(s=>{s.jobs.unshift(job);s.jobs=s.jobs.slice(0,100);if(type==='daily')s.settings.lastDailyAt=now();});}catch(error){pending.delete(key);throw error;}
   queue=queue.then(()=>execute(job)).catch(()=>{}).finally(()=>pending.delete(key));return job;
 }
 return {enqueue,execute,idle:()=>queue};
}
