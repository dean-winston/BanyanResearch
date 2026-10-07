import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
const dir=await mkdtemp(os.tmpdir()+'/pis-api-test-');
let child,port;
async function start(){child=spawn(process.execPath,['server.js'],{env:{...process.env,DATA_DIR:dir,PORT:'0',DISABLE_SCHEDULER:'1'},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('startup timeout')),10000);child.stdout.on('data',data=>{const match=String(data).match(/127\.0\.0\.1:(\d+)/);if(match){port=Number(match[1]);clearTimeout(timer);resolve();}});child.on('exit',()=>{clearTimeout(timer);reject(new Error('unexpected exit'));});});}
async function stop(){if(child?.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done;}
function request(url,method='GET',data,headers={}){return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:url,method,agent:false,headers:{'Content-Type':'application/json',...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(text)});}catch(error){reject(error);}});});req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));});}
test.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
test('API source/questions/settings preserve edits across restart; rejects bad inputs and cross-origin writes',async()=>{
 await start();let state=(await request('/api/state')).data;assert.equal(state.sources.length,21);assert.equal(state.settings.maxArticlesPerRun,15);
 const source=state.sources[0];assert.equal((await request('/api/sources/'+source.id,'PATCH',{notes:'编辑后的备注',enabled:false})).status,200);
 assert.equal((await request('/api/sources/'+source.id,'PATCH',{url:'javascript:alert(1)'})).status,400);
 const added=await request('/api/questions','POST',{title:'如何评估 Agent？',notes:'上下文',status:'active',topics:['ai'],url:''});assert.equal(added.status,201);
 assert.equal((await request('/api/questions/'+added.data.id,'PATCH',{status:'resolved'})).status,200);
 assert.equal((await request('/api/settings','PATCH',{dailyEnabled:false,maxArticlesPerRun:2,maxRepoAnalysesPerRun:1})).status,200);
 assert.equal((await request('/api/settings','PATCH',{dailyEnabled:true,maxArticlesPerRun:100000,maxRepoAnalysesPerRun:1})).status,400);
 assert.equal((await request('/api/settings','PATCH',{sourceArticleLimit:8,collectionSinceDays:60})).status,200);
 assert.equal((await request('/api/settings','PATCH',{sourceArticleLimit:21})).status,400);
 assert.equal((await request('/api/jobs','POST',{type:'invalid'})).status,400);
 assert.equal((await request('/api/questions','POST',null)).status,400);
 assert.equal((await request('/api/jobs','POST',{type:'daily'},{Origin:'https://evil.example'})).status,403);
 assert.equal((await request('/api/state','GET',undefined,{Host:'evil.example'})).status,403);
 await stop();await start();state=(await request('/api/state')).data;assert.equal(state.sources[0].notes,'编辑后的备注');assert.equal(state.sources[0].enabled,false);assert.equal(state.questions[0].status,'resolved');assert.equal(state.settings.maxArticlesPerRun,2);assert.equal(state.settings.sourceArticleLimit,8);assert.equal(state.settings.collectionSinceDays,60);
});
