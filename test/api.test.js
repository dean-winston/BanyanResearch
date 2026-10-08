import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import {migrate} from '../lib/state.js';
const dir=await mkdtemp(os.tmpdir()+'/pis-api-test-');
let child,port;
async function start(){child=spawn(process.execPath,['server.js'],{env:{...process.env,DATA_DIR:dir,PORT:'0',DISABLE_SCHEDULER:'1'},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('startup timeout')),10000);child.stdout.on('data',data=>{const match=String(data).match(/127\.0\.0\.1:(\d+)/);if(match){port=Number(match[1]);clearTimeout(timer);resolve();}});child.on('exit',()=>{clearTimeout(timer);reject(new Error('unexpected exit'));});});}
async function stop(){if(child?.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done;}
function request(url,method='GET',data,headers={}){return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:url,method,agent:false,headers:{'Content-Type':'application/json',...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(text)});}catch(error){reject(error);}});});req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));});}
test.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
test('API source/questions/settings preserve edits across restart; rejects bad inputs and cross-origin writes',async()=>{
 await start();let state=(await request('/api/state')).data;assert.equal(state.sources.length,migrate().sources.length);assert.equal(state.settings.maxArticlesPerRun,15);
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

test('recommendation feedback reasons persist through the local API and invalid reasons do not mutate',async()=>{
 const filename=dir+'/knowledge.json';
 const state=JSON.parse(await readFile(filename,'utf8'));
 state.recommendations.push({id:'reason-fixture',title:'Fixture',feedback:'new'});
 await writeFile(filename,JSON.stringify(state));
 const invalid=await request('/api/recommendations/reason-fixture','PATCH',{feedback:'irrelevant',feedbackReason:'unsupported'});
 assert.equal(invalid.status,400);
 assert.equal((await request('/api/state')).data.recommendations.find(item=>item.id==='reason-fixture').feedback,'new');
 const saved=await request('/api/recommendations/reason-fixture','PATCH',{feedback:'irrelevant',feedbackReason:'depth'});
 assert.equal(saved.status,200);
 assert.equal(saved.data.feedbackReason,'depth');
 await stop();await start();
 assert.equal((await request('/api/state')).data.recommendations.find(item=>item.id==='reason-fixture').feedbackReason,'depth');
 const reset=await request('/api/recommendations/reason-fixture','PATCH',{feedback:'new'});
 assert.equal(reset.data.feedbackReason,'');
});

test('reading decision page serves new modules and stylesheet with correct content types',async()=>{
 const index=await fetch('http://127.0.0.1:'+port+'/');
 const html=await index.text();
 assert.match(html,/id="recommendHistory"/);
 assert.match(html,/href="\/reading.css"/);
 assert.equal((html.match(/id="readingDigest"/g)||[]).length,1);
 for(const [filename,type] of [['reading-view.js','text/javascript'],['digest.js','text/javascript'],['reading.css','text/css']]){
  const response=await fetch('http://127.0.0.1:'+port+'/'+filename);
  assert.equal(response.status,200);
  assert(response.headers.get('content-type').includes(type));
 }
});
