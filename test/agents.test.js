import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pis-agents-test-'));
process.env.DATA_DIR=dir;
const {readStore,updateStore}=await import('../lib/store.js');
const {migrate}=await import('../lib/state.js');
const {changeAgentSettings,changeAgent,planAgent,finishAgent,makeDurableJob}=await import('../lib/agents.js');
test.after(()=>fs.rm(dir,{recursive:true,force:true}));
test.beforeEach(async()=>{await updateStore(s=>{for(const key of Object.keys(s))delete s[key];Object.assign(s,migrate({}));});});
const settings={enabled:true,wakeIntervalHours:24,maxDecisionsPerDay:3,maxActionsPerDay:6};
const plan=(action='collect')=>({action,reason:'已有资料支持本轮动作',memory:'保留研究问题并等待结果',nextWakeHours:24});

test('autonomous agents default off and do not invoke the model until explicitly enabled',async()=>{
 let calls=0;const runner=async()=>{calls++;return plan();};
 assert.equal((await readStore()).agentSettings.enabled,false);
 assert.equal(await planAgent('research','off',runner),null);assert.equal(calls,0);
 await changeAgentSettings(settings);assert.equal((await planAgent('research','on',runner)).action,'collect');assert.equal(calls,1);
});

test('daily decision budget is shared across agents and resets on the next UTC day',async()=>{
 await changeAgentSettings({...settings,maxDecisionsPerDay:1});let calls=0;
 const runner=async()=>{calls++;return plan('wait');};
 assert(await planAgent('research','one',runner));assert.equal(await planAgent('writing','two',runner),null);assert.equal(calls,1);
 let s=await readStore();assert.equal(s.agentUsage.decisions,1);assert.equal(s.agents.find(a=>a.id==='writing').status,'budget_limited');
 await updateStore(s=>{s.agentUsage.date='2000-01-01';});
 assert(await planAgent('writing','tomorrow',runner));s=await readStore();assert.equal(calls,2);assert.equal(s.agentUsage.decisions,1);
});

test('daily action budget converts additional work to wait and never overspends',async()=>{
 await changeAgentSettings({...settings,maxActionsPerDay:1});
 const first=await planAgent('research','first',async()=>plan('collect'));
 const second=await planAgent('writing','second',async()=>plan('blog'));
 assert.equal(first.action,'collect');assert.equal(second.action,'wait');
 const s=await readStore();assert.equal(s.agentUsage.actions,1);assert.equal(s.agentUsage.decisions,2);assert.equal(s.agents.find(a=>a.id==='writing').status,'budget_limited');
 await finishAgent(second,{status:'success'});assert.equal((await readStore()).agents.find(a=>a.id==='writing').status,'budget_limited');
});

test('concurrent and repeated identical wake uses one model decision and one action reservation',async()=>{
 await changeAgentSettings(settings);let release,entered;const started=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});let calls=0;
 const runner=async()=>{calls++;entered();await gate;return plan();};
 const pending=planAgent('research','same-wake',runner);await started;
 assert.equal(await planAgent('research','same-wake',runner),null);release();
 const first=await pending,again=await planAgent('research','same-wake',runner);
 assert.equal(again.jobId,first.jobId);assert.equal(calls,1);
 const s=await readStore();assert.equal(s.agentUsage.decisions,1);assert.equal(s.agentUsage.actions,1);assert.equal(s.agentDecisions.length,1);
});

test('engineering cannot be enabled or autonomously planned; manual repository jobs deduplicate',async()=>{
 await changeAgentSettings(settings);await assert.rejects(changeAgent('engineering',{enabled:true}),/手动/);
 let calls=0;assert.equal(await planAgent('engineering','wake',async()=>{calls++;return plan();}),null);assert.equal(calls,0);
 await updateStore(s=>{s.repositories=[{id:'github:1',name:'Owned',fork:false},{id:'github:2',name:'Fork',fork:true}];});
 await assert.rejects(makeDurableJob('repositories','fork-job','github:2'),/fork/);
 const first=await makeDurableJob('repositories','manual-repo','github:1'),again=await makeDurableJob('repositories','manual-repo','github:1');
 assert.equal(first.id,again.id);assert.equal(first.repositoryId,'github:1');assert.equal((await readStore()).jobs.length,1);
});

test('finish is idempotent and next-wake gate prevents early repeated work',async()=>{
 await changeAgentSettings(settings);let calls=0;
 const decision=await planAgent('research','finish',async()=>{calls++;return plan();});
 await finishAgent(decision,{status:'success',message:'入库两篇文章'});
 const first=await readStore();const memory=first.agents.find(a=>a.id==='research').memory;
 await finishAgent(decision,{status:'failed',message:'重复回调不能覆盖结果'});
 const second=await readStore();assert.equal(second.agentEvents.length,1);assert.equal(second.agentEvents[0].status,'success');assert.equal(second.agents.find(a=>a.id==='research').memory,memory);
 assert.equal(await planAgent('research','too-soon',async()=>{calls++;return plan();}),null);assert.equal(calls,1);
});

test('invalid action is rejected, recorded failed and identical wake does not call model again',async()=>{
 await changeAgentSettings(settings);let calls=0;const runner=async()=>{calls++;return plan('repositories');};
 await assert.rejects(planAgent('research','invalid',runner),/格式/);
 assert.equal(await planAgent('research','invalid',runner),null);assert.equal(calls,1);
 const s=await readStore();assert.equal(s.agentUsage.actions,0);assert.equal(s.agentDecisions[0].status,'failed');
});
