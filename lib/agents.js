import {readStore,updateStore} from '#knowledge-store';
import {runStructured} from '#analysis-provider';
const now=()=>new Date().toISOString();
const actions={research:['collect','recommend','wait'],writing:['blog','wait'],engineering:['wait']};
export async function changeAgentSettings(input){
 if(typeof input.enabled!=='boolean'||!Number.isInteger(input.wakeIntervalHours)||input.wakeIntervalHours<1||input.wakeIntervalHours>168||!['maxDecisionsPerDay','maxActionsPerDay'].every(k=>Number.isInteger(input[k])&&input[k]>=1&&input[k]<=100))throw Object.assign(new Error('助手设置无效'),{status:400});
 if(input.checkIntervalHours!==undefined&&(!Number.isInteger(input.checkIntervalHours)||input.checkIntervalHours<1||input.checkIntervalHours>168))throw Object.assign(new Error('自动检查间隔应为 1–168 小时的整数'),{status:400});
 return updateStore(s=>{if(input.checkIntervalHours!==undefined){if(s.agentSettings.checkIntervalHours!==input.checkIntervalHours)s.agentSchedule={lastCheckAt:''};s.agentSettings.checkIntervalHours=input.checkIntervalHours;}return Object.assign(s.agentSettings,{enabled:input.enabled,wakeIntervalHours:input.wakeIntervalHours,maxDecisionsPerDay:input.maxDecisionsPerDay,maxActionsPerDay:input.maxActionsPerDay});});
}
export async function changeAgent(id,input){return updateStore(s=>{const a=s.agents.find(a=>a.id===id);if(!a)throw Object.assign(new Error('Agent 不存在'),{status:404});if(typeof input.enabled!=='boolean')throw Object.assign(new Error('启用状态无效'),{status:400});if(id==='engineering'&&input.enabled)throw Object.assign(new Error('工程 Agent 仅允许手动分析'),{status:400});a.enabled=input.enabled;a.status=a.enabled?'idle':'paused';if(input.goal!==undefined){if(typeof input.goal!=='string'||!input.goal.trim()||input.goal.length>2000)throw Object.assign(new Error('目标无效'),{status:400});a.goal=input.goal.trim();}return a;});}
export async function planAgent(agentId,wakeId,runner=runStructured){
 const reservation=await updateStore(s=>{
  const existing=s.agentDecisions.find(d=>d.id===wakeId+':'+agentId);if(existing)return {existing};
  const a=s.agents.find(a=>a.id===agentId);if(!a||!a.enabled||!s.agentSettings.enabled||agentId==='engineering')return {skip:true};
  if(a.nextWakeAt&&Date.parse(a.nextWakeAt)>Date.now())return {skip:true};
  const date=now().slice(0,10);if(s.agentUsage.date!==date)s.agentUsage={date,decisions:0,actions:0};
  if(s.agentUsage.decisions>=s.agentSettings.maxDecisionsPerDay){a.status='budget_limited';a.lastReason='已达到今日决策上限';return {skip:true};}
  s.agentUsage.decisions++;a.status='planning';a.lastWakeAt=now();
  const decision={id:wakeId+':'+agentId,agentId,status:'planning',createdAt:now()};s.agentDecisions.unshift(decision);s.agentDecisions=s.agentDecisions.slice(0,500);return {decision,agent:a};
 });
 if(reservation.existing){if(reservation.existing.status==='planning'&&Date.now()-Date.parse(reservation.existing.createdAt)>600000)await updateStore(s=>{const d=s.agentDecisions.find(d=>d.id===reservation.existing.id),a=s.agents.find(a=>a.id===agentId);if(d.status==='planning'){d.status='interrupted';a.status='error';a.error='决策中断，本轮不重复调用模型；下一次唤醒重新评估';}});return reservation.existing.status==='ready'?reservation.existing:null;}
 if(reservation.skip)return null;
 const snapshot=await readStore(),agent=reservation.agent;
 try{
  const schema={type:'object',properties:{action:{type:'string',enum:actions[agentId]},reason:{type:'string'},memory:{type:'string'},nextWakeHours:{type:'integer',minimum:1,maximum:168}},required:['action','reason','memory','nextWakeHours'],additionalProperties:false};
  const plan=await runner('你是一个持续存在的个人研究助手。依据目标、工作记忆和当前状态，选择本轮一个必要动作或等待。避免反复采集没有变化的内容和无意义模型调用。仅能选择允许动作：collect采集并分析外部信息；recommend用现有摘要重新关联；blog同步自己的博客；wait等待。工程仓库不自动监听。memory简短记录事实和下一步，不要复制原文。', {agent,settings:snapshot.agentSettings,sources:snapshot.sources.map(s=>({name:s.name,enabled:s.enabled,lastCollection:s.lastCollection})),counts:{articles:snapshot.articles.length,blogs:snapshot.blogs.length,recommendations:snapshot.recommendations.length},questions:snapshot.questions.filter(q=>q.status==='active').map(q=>q.title),recentJobs:snapshot.jobs.slice(0,8).map(j=>({type:j.type,status:j.status,finishedAt:j.finishedAt,message:j.message})),feedback:snapshot.recommendations.filter(r=>r.feedback!=='new').slice(0,10).map(r=>({title:r.title,feedback:r.feedback}))},schema);
  if(!actions[agentId].includes(plan.action)||typeof plan.reason!=='string'||typeof plan.memory!=='string')throw new Error('Agent 计划格式无效');
  return updateStore(s=>{
   const a=s.agents.find(a=>a.id===agentId),d=s.agentDecisions.find(d=>d.id===reservation.decision.id);
   let action=plan.action;let limited=false;if(!s.agentSettings.enabled||!a.enabled)action='wait';
   if(action!=='wait'&&s.agentUsage.actions>=s.agentSettings.maxActionsPerDay){action='wait';limited=true;}
   if(action!=='wait')s.agentUsage.actions++;
   Object.assign(d,{status:'ready',action,budgetLimited:limited,reason:plan.reason.slice(0,1500),memory:plan.memory.slice(0,3000),nextWakeHours:Math.max(s.agentSettings.wakeIntervalHours,Math.min(168,Number(plan.nextWakeHours)||24)),jobId:crypto.randomUUID()});
   a.status=limited?'budget_limited':action==='wait'?'idle':'working';a.lastAction=action;a.lastReason=d.reason;a.error='';
   return d;
  });
 }catch(error){await updateStore(s=>{const a=s.agents.find(a=>a.id===agentId),d=s.agentDecisions.find(d=>d.id===reservation.decision.id);d.status='failed';a.status='error';a.error=error.message;a.nextWakeAt=new Date(Date.now()+s.agentSettings.wakeIntervalHours*3600000).toISOString();});throw error;}
}
export async function finishAgent(decision,result){await updateStore(s=>{
 const d=s.agentDecisions.find(d=>d.id===decision.id);if(!d||d.status==='complete')return;
 const a=s.agents.find(a=>a.id===decision.agentId);const status=result?.status||'success';
 d.status='complete';d.finishedAt=now();a.memory=decision.memory+'\n本轮结果：'+(result?.message||'等待下次唤醒').slice(0,600);a.status=!a.enabled?'paused':decision.budgetLimited?'budget_limited':['failed','partial'].includes(status)?'error':'idle';a.error=status==='failed'?result.message:'';a.nextWakeAt=new Date(Date.now()+decision.nextWakeHours*3600000).toISOString();
 s.agentEvents.unshift({id:decision.id,agentId:a.id,at:now(),action:decision.action,reason:decision.reason,status});s.agentEvents=s.agentEvents.slice(0,200);
});}
export async function makeDurableJob(type,id=crypto.randomUUID(),repositoryId){
 if(!['daily','collect','blog','repositories','recommend'].includes(type))throw Object.assign(new Error('任务类型无效'),{status:400});
 if(repositoryId!==undefined&&(type!=='repositories'||typeof repositoryId!=='string'||repositoryId.length>300))throw Object.assign(new Error('仓库参数无效'),{status:400});
 return updateStore(s=>{if(repositoryId&&!s.repositories.some(r=>r.id===repositoryId&&!r.fork))throw Object.assign(new Error('仓库不存在或为 fork'),{status:400});const existing=s.jobs.find(j=>j.id===id);if(existing)return existing;const job={id,type,repositoryId,status:'queued',createdAt:now(),startedAt:'',finishedAt:'',progress:0,message:'等待云端执行',errors:[]};s.jobs.unshift(job);s.jobs=[...s.jobs.filter(j=>['queued','running'].includes(j.status)),...s.jobs.filter(j=>!['queued','running'].includes(j.status)).slice(0,100)];return job;});
}
