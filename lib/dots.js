import {z} from 'zod';
import {referenceContext} from './analyzer.js';
import {saveAnalyzedArticles} from './jobs.js';
import {readingRules,preferences} from './reading.js';
import {applyRecommendationFeedback} from './feedback.js';

export const dotsDefaults={mode:'builtin',collectionEnabled:false,collectionIntervalHours:24,maxArticlesPerDay:10,maxRecommendationsPerDay:3,lastCollectionAt:''};
export const dotsConfigSchema=z.object({mode:z.enum(['builtin','dots']),collectionEnabled:z.boolean(),collectionIntervalHours:z.number().int().min(1).max(168),maxArticlesPerDay:z.number().int().min(1).max(50),maxRecommendationsPerDay:z.number().int().min(1).max(10)}).strict();
export function initDots(s){s.dotsSettings={...dotsDefaults,...s.dotsSettings};s.dotsQueue||=[];s.dotsBatches||=[];return s;}
const fail=message=>{throw Object.assign(new Error(message),{status:400});};
const iso=n=>new Date(n).toISOString();
export function configureDots(s,input){initDots(s);const parsed=dotsConfigSchema.safeParse(input);if(!parsed.success)fail('dots 设置格式或上限无效');const next=parsed.data;if(s.workflowLease?.expiresAt>Date.now()||s.jobs.some(j=>['running','queued'].includes(j.status)&&Date.now()-Date.parse(j.startedAt||j.createdAt)<3*3600000))fail('请等待当前任务结束后再切换执行方式');s.dotsSettings={...s.dotsSettings,...next};return s.dotsSettings;}
export function queueDots(s,candidates,jobId){initDots(s);let added=0;for(const a of candidates){if(s.dotsQueue.some(q=>q.article.id===a.id)||s.articles.some(q=>q.id===a.id))continue;const {id,title,url,sourceId,sourceName,sourceGroup,sourceKind,publishedAt,topics}=a;s.dotsQueue.push({id,article:{id,title,url,sourceId,sourceName,sourceGroup,sourceKind,publishedAt,topics},jobId,status:'pending',createdAt:iso(Date.now())});added++;}return added;}
const payload=b=>({id:b.id,leaseToken:b.leaseToken,status:b.status,expiresAt:b.expiresAt,maxRecommendations:b.maxRecommendations,articles:b.articles,receipt:b.receipt});
export function claimDots(s,{requestId,limit=10},owner,now=Date.now()){
 initDots(s);if(s.dotsSettings.mode!=='dots')fail('请先在持续助手页面切换到 dots');
 const previous=s.dotsBatches.find(b=>b.owner===owner&&b.requestId===requestId);if(previous){if(previous.status==='complete'||previous.expiresAt>now)return payload(previous);fail('此请求的领取已过期，请用新的 requestId 领取');}
 for(const b of s.dotsBatches)if(b.status==='claimed'&&b.expiresAt<=now){b.status='expired';for(const q of s.dotsQueue)if(q.batchId===b.id&&q.status==='claimed'){q.status='pending';delete q.batchId;}}
 const today=iso(now).slice(0,10),used=s.dotsBatches.filter(b=>b.day===today).reduce((n,b)=>n+b.articles.length,0);
 const selected=s.dotsQueue.filter(q=>q.status==='pending'&&s.sources.find(x=>x.id===q.article.sourceId)?.enabled!==false).slice(0,Math.max(0,Math.min(limit,s.dotsSettings.maxArticlesPerDay-used)));
 if(!selected.length)return {status:'empty',reason:used>=s.dotsSettings.maxArticlesPerDay?'daily_limit':'no_candidates',articles:[]};
 const b={id:crypto.randomUUID(),owner,requestId,leaseToken:crypto.randomUUID(),day:today,status:'claimed',expiresAt:now+2*3600000,maxRecommendations:Math.max(0,s.dotsSettings.maxRecommendationsPerDay-s.dotsBatches.filter(x=>x.status==='complete'&&x.completedDay===today).reduce((n,x)=>n+x.receipt.recommended,0)),articles:selected.map(q=>q.article),createdAt:iso(now)};
 s.dotsBatches.push(b);for(const q of selected){q.status='claimed';q.batchId=b.id;}return payload(b);
}
const short=z.string().trim().min(1);
export const analysisSchema=z.object({id:short.max(150),summary:short.max(600),topics:z.array(z.enum(['ai','game','backend'])).max(3),problem:z.string().max(300),method:z.string().max(300),conclusion:z.string().max(300),rationale:short.max(1000),technicalGain:z.string().max(400),evidence:short.max(500),limitations:short.max(400),researchQuestion:z.string().max(200),qualityScore:z.number().int().min(0).max(100),eventKey:z.string().max(160),recommend:z.boolean(),readingScope:z.enum(['original_excerpt','original_full','feed_summary','unavailable']),relations:z.array(z.object({referenceId:short.max(200),reason:short.max(500)}).strict()).max(10)}).strict();
export const submitSchema=z.object({batchId:short.max(100),leaseToken:short.max(100),results:z.array(analysisSchema).min(1).max(50)}).strict();
export function submitDots(s,input,owner,now=Date.now()){
 initDots(s);const data=submitSchema.parse(input),b=s.dotsBatches.find(b=>b.id===data.batchId&&b.owner===owner&&b.leaseToken===data.leaseToken);if(!b)fail('领取凭据无效');
 if(b.status==='complete')return b.receipt;
 if(s.dotsSettings.mode!=='dots')fail('dots 已暂停');if(b.status!=='claimed'||b.expiresAt<=now)fail('领取已过期，请重新领取');
 if(data.results.length!==b.articles.length||new Set(data.results.map(a=>a.id)).size!==b.articles.length||data.results.some(a=>!b.articles.some(x=>x.id===a.id)))fail('必须为领取的每篇文章提交一次判断');
 const refs=[...s.questions.filter(q=>q.status==='active').map(q=>({referenceId:'question:'+q.id,kind:'question',id:q.id,title:q.title,url:q.url||''})),...s.blogs.map(q=>({referenceId:'blog:'+q.id,kind:'blog',id:q.id,title:q.title,url:q.url})),...s.repositories.filter(q=>!q.fork&&q.card).map(q=>({referenceId:'repository:'+q.id,kind:'repository',id:q.id,title:q.name,url:q.url}))];
 const selected=data.results.filter(a=>a.recommend);
 const today=iso(now).slice(0,10),used=s.dotsBatches.filter(x=>x.status==='complete'&&x.completedDay===today).reduce((n,x)=>n+x.receipt.recommended,0);
 if(selected.length>Math.max(0,Math.min(b.maxRecommendations,s.dotsSettings.maxRecommendationsPerDay-used)))fail('超过今日推荐上限，请减少推荐数量');
 for(const a of data.results){if(a.recommend&&(a.qualityScore<70||!['original_excerpt','original_full'].includes(a.readingScope)))fail('推荐需要至少 70 分且已阅读原文；未读到原文请不推荐');if(a.relations.some(r=>!refs.some(x=>x.referenceId===r.referenceId)))fail('研究关联不存在，请重新获取研究背景');}
 const results=data.results.map(a=>({...a,relations:a.relations.map(r=>{const ref=refs.find(x=>x.referenceId===r.referenceId);return {kind:ref.kind,id:ref.id,title:ref.title,url:ref.url,reason:r.reason};})}));
 const jobId='dots-'+b.id;saveAnalyzedArticles(s,b.articles,results,{jobId,provider:'dots',model:'dots'});
 for(const q of s.dotsQueue)if(q.batchId===b.id){q.status='complete';q.completedAt=iso(now);}
 b.status='complete';b.completedDay=today;b.receipt={batchId:b.id,processed:results.length,recommended:selected.length,completedAt:iso(now)};
 s.jobs.unshift({id:jobId,type:'recommend',status:'success',createdAt:b.createdAt,startedAt:b.createdAt,finishedAt:iso(now),progress:100,errors:[],message:`dots 已研究 ${results.length} 篇，推荐 ${selected.length} 篇`});s.jobs=s.jobs.slice(0,100);return b.receipt;
}
export function dotsContext(s,query=''){initDots(s);return {rules:readingRules,preferences:preferences.focus,settings:s.dotsSettings,references:referenceContext(s,query).map(r=>({...r,knowledgeId:r.kind==='question'?null:'derived:'+r.id})),questions:s.questions.filter(q=>!q.superseded).slice(0,100),feedback:s.recommendations.filter(r=>r.feedback!=='new').sort((a,b)=>(b.feedbackAt||'').localeCompare(a.feedbackAt||'')).slice(0,100).map(({id,title,feedback,feedbackReason,rationale})=>({id,title,feedback,feedbackReason,rationale}))};}
export function dotsStatus(s){initDots(s);return {settings:s.dotsSettings,pending:s.dotsQueue.filter(q=>s.sources.find(x=>x.id===q.article.sourceId)?.enabled!==false&&(q.status==='pending'||q.status==='claimed'&&s.dotsBatches.find(b=>b.id===q.batchId)?.expiresAt<Date.now())).length,batches:s.dotsBatches.slice(-20).reverse().map(({id,status,createdAt,expiresAt,receipt})=>({id,status:status==='claimed'&&expiresAt<Date.now()?'expired':status,createdAt,expiresAt,receipt})),connected:Boolean(s.mcpAuth?.tokens?.some(t=>t.expiresAt>Date.now())),lastConnectedAt:s.mcpAuth?.lastConnectedAt||''};}
export const feedbackSchema=z.object({id:short.max(150),feedback:z.enum(['new','useful','irrelevant','known','later']),feedbackReason:z.enum(['','depth','duplicate','evidence','topic','source']).optional()}).strict();
export const questionSchema=z.object({id:short.max(150).optional(),title:short.max(300),notes:z.string().max(4000),status:z.enum(['active','paused','resolved']),topics:z.array(z.enum(['ai','game','backend'])).max(3)}).strict();
export function updateDotsQuestion(s,input){const d=questionSchema.parse(input),old=d.id?s.questions.find(q=>q.id===d.id):null;if(d.id&&!old)fail('研究问题不存在');const q={...old,...d,id:old?.id||crypto.randomUUID(),humanEdited:true,origin:old?.origin||'dots',updatedAt:iso(Date.now())};if(old)Object.assign(old,q);else s.questions.push(q);for(const r of s.recommendations)if(r.relations?.some(v=>v.kind==='question'&&v.id===q.id)){r.stale=true;r.staleReason='研究问题已更新，需要重新匹配';}return q;}
export const setDotsFeedback=(s,d)=>applyRecommendationFeedback(s,d.id,feedbackSchema.parse(d));
