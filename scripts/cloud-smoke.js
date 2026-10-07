// Run against wrangler dev only. Uses test credentials and never enables Agents.
import http from 'node:http';
import assert from 'node:assert/strict';
const port=Number(process.env.CLOUD_TEST_PORT||8787);
function request(path,body,headers={},method=body?'POST':'GET'){
 return new Promise((resolve,reject)=>{const data=body?JSON.stringify(body):undefined;const req=http.request({agent:new http.Agent(),host:'127.0.0.1',port,path,method,headers:{'content-type':'application/json',...headers}},res=>{let raw='';res.setEncoding('utf8');res.on('data',s=>raw+=s);res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(raw),headers:res.headers});}catch(e){reject(new Error(path+' HTTP '+res.statusCode+' '+raw.slice(0,200)));}});});req.on('error',reject);req.end(data);});
}
assert.equal((await request('/api/state')).status,401);
const login=await request('/api/login',{password:'local-integration-only'});assert.equal(login.status,200);
const headers={cookie:login.headers['set-cookie'][0].split(';')[0]};
const state=(await request('/api/state',undefined,headers)).data;
assert.equal(state.runtime.deployment,'cloud');assert.equal(state.runtime.available,false);assert.equal(state.agentSettings.enabled,false);
assert.equal((await request('/api/agent-settings',{}, {...headers,origin:'https://evil.example'},'PATCH')).status,403);
assert.equal((await request('/api/jobs',{type:'collect'},headers)).status,503);
const path='/cdn-cgi/local/explorer/api/workflows/personal-intelligence-work/instances';
const id='smoke-'+crypto.randomUUID();
assert.equal((await request(path,{id,params:{type:'agents'}})).data.success,true);
let result;
for(let i=0;i<30;i++){result=(await request(path+'/'+id)).data.result;if(['complete','errored'].includes(result.status))break;await new Promise(r=>setTimeout(r,200));}
assert.equal(result.status,'complete',JSON.stringify(result.error));
assert.ok(result.steps.some(s=>s.name.startsWith('plan-writing')));
assert.ok(result.steps.some(s=>s.name.startsWith('plan-research')));
assert.ok(result.steps.some(s=>s.name.startsWith('release')));
console.log('Cloud local integration passed: authentication, D1, request guards, model configuration gate, durable workflow lifecycle (Agents disabled).');
