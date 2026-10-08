import {applySettings,claimAgentCheck} from '../lib/settings.js';
import {applyRecommendationFeedback} from '../lib/feedback.js';
export {IntelligenceTasks} from './task-service.js';
import {WorkflowEntrypoint} from 'cloudflare:workers';
import {readStore,updateStore,initializeStore} from './runtime-store.js';
import {runtimeStatus,runStructured} from './providers.js';
import {createCloudJobRunner} from './job-runner.js';
import {knowledgeItems} from '../lib/knowledge.js';
import {planAgent,finishAgent,makeDurableJob,changeAgent,changeAgentSettings} from '../lib/agents.js';
import {authenticated,equalSecrets,sessionCookie} from './auth.js';
import {publicURL} from './network.js';
const response=(data,status=200,headers={})=>Response.json(data,{status,headers:{'Cache-Control':'no-store',...headers}});
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const text=(v,n)=>typeof v==='string'?v.trim().slice(0,n):'';
async function input(request){const reader=request.body?.getReader(),decoder=new TextDecoder();let raw='',size=0;if(reader)try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>2_000_000){await reader.cancel();fail('请求过大',413);}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();}finally{reader.releaseLock();}try{const value=JSON.parse(raw||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}catch{fail('JSON 格式无效');}}
const webUrl=(value,optional=false)=>{if(!value&&optional)return '';try{return publicURL(value).href;}catch{fail('请输入有效的公开 HTTP(S) 网址');}};
async function startWorkflow(env,params,id=crypto.randomUUID()){await env.WORK.create({id,params});return {id,status:'queued'};}
export class IntelligenceWorkflow extends WorkflowEntrypoint{
 async run(event,step){
  const workflowId=event.instanceId;
  const acquired=await step.do('acquire',()=>updateStore(s=>{if(s.workflowLease&&s.workflowLease.id!==workflowId&&s.workflowLease.expiresAt>Date.now())return false;s.workflowLease={id:workflowId,expiresAt:Date.now()+3*3600000};return true;}));
  if(!acquired){await step.do('record busy',()=>updateStore(s=>{const j=s.jobs.find(j=>j.id===event.payload.jobId);if(j){j.status='failed';j.message='其他工作流仍在执行，请完成后重试';j.finishedAt=new Date().toISOString();}}));return {status:'busy'};}
  try{
   if(event.payload.type==='agents'){
    for(const agentId of ['writing','research']){
     const decision=await step.do('plan-'+agentId,{retries:{limit:0,delay:'1 second',backoff:'constant'},timeout:'5 minutes'},()=>planAgent(agentId,workflowId));
     if(!decision)continue;
     let result={status:'success',message:'等待下次唤醒'};
     if(decision.action!=='wait')result=await (async()=>{
      const s=await readStore();if(!s.agentSettings.enabled||!s.agents.find(a=>a.id===agentId)?.enabled)return {status:'success',message:'助手已暂停，未执行计划动作'};
      const job=await makeDurableJob(decision.action,decision.jobId);if(!['success','partial'].includes(job.status))await createCloudJobRunner(step,job.id,this.env.TASKS).execute(job);
      const updated=(await readStore()).jobs.find(j=>j.id===job.id);return {status:updated.status,message:updated.message};
     })();
     await step.do('remember-'+agentId,()=>finishAgent(decision,result));
    }
   }else{
    await (async()=>{const s=await readStore(),job=s.jobs.find(j=>j.id===event.payload.jobId);if(!job)throw new Error('任务不存在');if(!['success','partial'].includes(job.status))await createCloudJobRunner(step,job.id,this.env.TASKS).execute(job);return {status:'finished'};})();
   }
  }catch(error){await step.do('record failure',()=>updateStore(s=>{const j=s.jobs.find(j=>j.id===event.payload.jobId);if(j){j.status='failed';j.message=error.message.slice(0,500);j.finishedAt=new Date().toISOString();}for(const a of s.agents)if(['planning','working'].includes(a.status)){a.status='error';a.error='工作流中断，可在下一次唤醒重试';}}));throw error;}
  finally{await step.do('release',()=>updateStore(s=>{if(s.workflowLease?.id===workflowId)s.workflowLease=null;}));}
 }
}
async function api(request,env,url){
 await initializeStore();
 if(!env.ADMIN_PASSWORD||!env.SESSION_SECRET)return response({error:'云端尚未配置 ADMIN_PASSWORD 和 SESSION_SECRET'},503);
 if(request.method!=='GET'){
  const origin=request.headers.get('Origin');if(origin&&origin!==url.origin)return response({error:'跨站请求已拒绝'},403);
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))return response({error:'请使用 application/json'},415);
 }
 if(url.pathname==='/api/login'&&request.method==='POST'){
  const data=await input(request);
  // Persist a global login throttle rather than depending on an evictable process counter.
  const allowed=await updateStore(s=>{const bucket=Math.floor(Date.now()/60000);if(s.loginAttempts?.bucket!==bucket)s.loginAttempts={bucket,count:0};return ++s.loginAttempts.count<=10;});
  if(!allowed)return response({error:'登录尝试过多，请一分钟后重试'},429);
  if(typeof data.password!=='string'||!await equalSecrets(data.password,env.ADMIN_PASSWORD))return response({error:'密码错误'},401);
  return response({ok:true},200,{'Set-Cookie':await sessionCookie(env,request.url)});
 }
 if(!await authenticated(request,env))return response({error:'请先登录'},401);
 if(url.pathname==='/api/logout'&&request.method==='POST')return response({ok:true},200,{'Set-Cookie':'pis_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure'});
 const runtime={...await runtimeStatus(),deployment:'cloud'};
 if(request.method==='GET'&&url.pathname==='/api/state'){const store=await readStore();const {loginAttempts,workflowLease,...visible}=store;return response({...visible,items:knowledgeItems(store),runtime,modelEnabled:runtime.available});}
 const data=request.method==='GET'?{}:await input(request),id=decodeURIComponent(url.pathname.split('/').pop());
 const sourceCheck=/^\/api\/sources\/([^/]+)\/check$/.exec(url.pathname);
 if(request.method==='POST'&&sourceCheck){
  const sourceId=decodeURIComponent(sourceCheck[1]),store=await readStore(),source=store.sources.find(s=>s.id===sourceId);if(!source)fail('信息源不存在',404);
  const result=await env.TASKS.discover(source,{limit:store.settings.sourceArticleLimit,sinceDays:store.settings.collectionSinceDays});
  const checkedAt=new Date().toISOString();
  await updateStore(s=>{const target=s.sources.find(x=>x.id===sourceId);if(target&&target.url===source.url&&target.feedUrl===source.feedUrl){target.checkedAt=checkedAt;target.verification=result.status==='error'?'采集失败，见最近结果':result.feedUrl?'订阅采集已验证':'网页采集已验证';target.httpStatus='';target.lastCollection={status:result.status,at:checkedAt,count:result.articles.length,error:result.error||''};}});
  return response({status:result.status,count:result.articles.length,error:result.error||''});
 }
 if(request.method==='POST'&&url.pathname==='/api/jobs'){
  if(!runtime.available)fail(runtime.error||'请先配置云端模型',503);
  const job=await makeDurableJob(data.type,undefined,data.repositoryId);
  try{await startWorkflow(env,{type:'job',jobId:job.id},job.id);}catch{await updateStore(s=>{const j=s.jobs.find(j=>j.id===job.id);j.status='failed';j.message='工作流创建失败，请重试';});fail('工作流创建失败',502);}return response(job,202);
 }
 if(request.method==='PATCH'&&url.pathname==='/api/agent-settings')return response(await changeAgentSettings(data));
 if(request.method==='PATCH'&&url.pathname.startsWith('/api/agents/'))return response(await changeAgent(id,data));
 if(request.method==='POST'&&url.pathname==='/api/agents/wake'){
  if(!runtime.available)fail(runtime.error||'请先配置云端模型',503);
  if(!(await readStore()).agentSettings.enabled)fail('请先启用持续 Agent');
  return response(await startWorkflow(env,{type:'agents'}),202);
 }
 if(request.method==='PATCH'&&url.pathname==='/api/settings'){
  if(data.dailyEnabled===true&&env.ENABLE_LEGACY_DAILY!=='true')fail('云端自动运行请在持续助手页面开启');
  return response(await updateStore(s=>applySettings(s.settings,data)));
 }
 if(request.method==='PATCH'&&url.pathname.startsWith('/api/recommendations/')){
  if(!['new','useful','irrelevant','known','later'].includes(data.feedback))fail('反馈无效');
  return response(await updateStore(store=>applyRecommendationFeedback(store,id,data)));
 }
 if((request.method==='POST'&&url.pathname==='/api/sources')||(request.method==='PATCH'&&url.pathname.startsWith('/api/sources/'))){
  return response(await updateStore(s=>{const old=request.method==='PATCH'?s.sources.find(v=>v.id===id):null;if(request.method==='PATCH'&&!old)fail('信息源不存在',404);const d={...old,...data};if(!text(d.name,160)||!['blogger','company','news'].includes(d.type)||!Array.isArray(d.topics)||!d.topics.length||d.topics.some(t=>!['ai','game','backend'].includes(t))||!['en','zh','other'].includes(d.language)||typeof d.enabled!=='boolean')fail('信息源字段无效');const link=webUrl(d.url);if(s.sources.some(v=>v.id!==old?.id&&v.url.replace(/\/$/,'')===link.replace(/\/$/,'')))fail('网址已经存在');const result={...old,id:old?.id||crypto.randomUUID(),name:text(d.name,160),url:link,feedUrl:webUrl(d.feedUrl,true),type:d.type,topics:[...new Set(d.topics)],language:d.language,notes:text(d.notes,4000),enabled:d.enabled,updatedAt:new Date().toISOString()};const changedUrl=old&&(old.url!==result.url||old.feedUrl!==result.feedUrl);if(!old||changedUrl){result.verification='待验证';result.checkedAt='';result.httpStatus='';}if(old){Object.assign(old,result);if(changedUrl)for(const r of s.recommendations){if(s.articles.find(a=>a.id===r.articleId)?.sourceId===old.id){r.stale=true;r.staleReason='信息源网址已修改，原有推荐待复核';}}}else s.sources.unshift(result);return result;}),request.method==='POST'?201:200);
 }
 if((request.method==='POST'&&url.pathname==='/api/questions')||(request.method==='PATCH'&&url.pathname.startsWith('/api/questions/'))){
  return response(await updateStore(s=>{const old=request.method==='PATCH'?s.questions.find(v=>v.id===id):null;if(request.method==='PATCH'&&!old)fail('问题不存在',404);const d={...old,...data};if(!text(d.title,300)||!['active','paused','resolved'].includes(d.status)||!Array.isArray(d.topics)||d.topics.some(t=>!['ai','game','backend'].includes(t)))fail('问题字段无效');const result={...old,id:old?.id||crypto.randomUUID(),title:text(d.title,300),notes:text(d.notes,4000),status:d.status,topics:[...new Set(d.topics)],url:webUrl(d.url,true),humanEdited:true,origin:old?.origin||'manual',updatedAt:new Date().toISOString()};if(old)Object.assign(old,result);else s.questions.unshift(result);for(const r of s.recommendations)if(r.relations?.some(v=>v.kind==='question'&&v.id===result.id)){r.stale=true;r.staleReason='研究问题已更新，需要重新匹配';}return result;}),request.method==='POST'?201:200);
 }
 if(request.method==='POST'&&url.pathname==='/api/items'){
  if(!['research','writing','engineering'].includes(data.category)||!text(data.title,200)||!text(data.content,100000))fail('知识内容无效');
  const item={id:crypto.randomUUID(),category:data.category,title:text(data.title,200),content:text(data.content,100000),source:text(data.source,1000),createdAt:new Date().toISOString()};await updateStore(s=>s.items.unshift(item));return response(item,201);
 }
 if(request.method==='DELETE'&&url.pathname.startsWith('/api/items/'))return response(await updateStore(s=>{const before=s.items.length;s.items=s.items.filter(i=>i.id!==id);return {deleted:before!==s.items.length};}));
 if(request.method==='POST'&&url.pathname==='/api/ask'){
  const question=text(data.question,2000);if(!question)fail('请输入问题');const terms=question.toLowerCase().match(/[a-z]{2,}|[\p{Script=Han}]/gu)||[];
  const selected=knowledgeItems(await readStore()).map(item=>({item,score:terms.reduce((n,t)=>n+(item.title+' '+item.content).toLowerCase().includes(t),0)})).filter(x=>x.score).sort((a,b)=>b.score-a.score).slice(0,8).map(x=>x.item);
  if(!selected.length)return response({answer:'未找到相关资料。',sources:[]});
  const answer=await runStructured('依据提供资料回答，使用[1]来源序号引用。',{question,context:selected.map((s,i)=>({index:i+1,title:s.title,content:s.content.slice(0,7000)}))},{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false});
  const result={id:crypto.randomUUID(),question,answer:answer.answer,sources:selected.map(({id,title,category,source})=>({id,title,category,source})),createdAt:new Date().toISOString()};await updateStore(s=>{s.answers.unshift(result);s.answers=s.answers.slice(0,100);});return response(result);
 }
 if(request.method==='POST'&&url.pathname==='/api/import')fail('云端不能读取本机文件夹，请使用本地版本导入后迁移',400);
 return response({error:'未找到接口'},404);
}
export default {
 async fetch(request,env){const url=new URL(request.url);try{if(url.pathname.startsWith('/api/'))return await api(request,env,url);return await env.ASSETS.fetch(request);}catch(error){const safeModel=/^(云端分析|无法连接云端分析服务|分析输入超过长度限制|请配置 DEEPSEEK_API_KEY|请明确配置 DEEPSEEK_MODEL)/.test(error.message||'');if(!error.status)console.error('Worker request failed',{name:error.name,...(safeModel?{message:error.message}:{})});return response({error:error.status||safeModel?error.message:'云端处理失败，请查看部署日志'},error.status||(safeModel?502:500));}},
 async scheduled(event,env){await initializeStore();const s=await readStore();if(!(await runtimeStatus()).available||s.workflowLease?.expiresAt>Date.now())return;
  if(s.agentSettings.enabled){if(!await updateStore(s=>claimAgentCheck(s,event.scheduledTime)))return;const id='agents-'+Math.floor(event.scheduledTime/3600000);try{await startWorkflow(env,{type:'agents'},id);}catch(error){if(!/already exists|duplicate/i.test(error.message))throw error;}}
  // Legacy daily timer does not run in parallel with continuous Agents.
  else if(s.settings.dailyEnabled&&env.ENABLE_LEGACY_DAILY==='true'&&Date.now()-Date.parse(s.settings.lastDailyAt||0)>=86400000){const job=await makeDurableJob('daily');await updateStore(s=>{s.settings.lastDailyAt=new Date().toISOString();});await startWorkflow(env,{type:'job',jobId:job.id},job.id);}
 }
};
