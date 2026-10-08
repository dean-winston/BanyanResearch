import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {oauth,mcpIdentity} from '../cloud/mcp-auth.js';
import {mcp} from '../cloud/mcp.js';
import {migrate} from '../lib/state.js';
const base='https://banyan.example',env={ADMIN_PASSWORD:'fixture-password-only',SESSION_SECRET:'fixture-session-secret-only'};
const makeStore=()=>{let state=migrate();return {readStore:async()=>structuredClone(state),updateStore:async fn=>{const copy=structuredClone(state);const result=await fn(copy);state=copy;return result;}};};
const jsonRequest=(path,data)=>new Request(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
const verifier='v'.repeat(64),proof=createHash('sha256').update(verifier).digest('base64url');
async function setup(store,scope='research:read research:write'){
 const r=await oauth(jsonRequest('/oauth/register',{redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect'],token_endpoint_auth_method:'none'}),env,store);assert.equal(r.status,201);const c=await r.json();
 const q=new URLSearchParams({client_id:c.client_id,redirect_uri:c.redirect_uris[0],response_type:'code',code_challenge:proof,code_challenge_method:'S256',resource:base+'/mcp',scope,state:'state-test'});const path='/oauth/authorize?'+q;
 const page=await oauth(new Request(base+path),env,store);assert.equal(page.status,200);const html=await page.text(),nonce=html.match(/name="nonce" value="([a-f0-9]+)"/)[1];
 const consent=()=>new Request(base+path,{method:'POST',headers:{Origin:base,Cookie:'__Host-banyan_oauth='+nonce,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({nonce,password:env.ADMIN_PASSWORD,decision:'allow'})});
 const approved=await oauth(consent(),env,store);assert.equal(approved.status,303);const callback=new URL(approved.headers.get('Location'));assert.equal(callback.searchParams.get('iss'),base);assert.equal(callback.searchParams.get('state'),'state-test');
 return {clientId:c.client_id,code:callback.searchParams.get('code'),redirect:c.redirect_uris[0],consent};
}
const exchange=(store,d,overrides={})=>oauth(new Request(base+'/oauth/token',{method:'POST',body:new URLSearchParams({client_id:d.clientId,grant_type:'authorization_code',code:d.code,code_verifier:verifier,redirect_uri:d.redirect,resource:base+'/mcp',...overrides})}),env,store);
test('OAuth discovery, consent, PKCE, single-use code, audience, rotated refresh and revocation',async()=>{
 const s=makeStore();const md=await (await oauth(new Request(base+'/.well-known/oauth-authorization-server'),env,s)).json();assert.deepEqual(md.code_challenge_methods_supported,['S256']);
 assert.equal((await oauth(jsonRequest('/oauth/register',{redirect_uris:['https://evil.example/callback']}),env,s)).status,400);
 const d=await setup(s);assert.equal((await exchange(s,d,{code_verifier:'x'.repeat(64)})).status,400);assert.equal((await exchange(s,d,{resource:'https://evil.example/mcp'})).status,400);
 const response=await exchange(s,d);assert.equal(response.status,200);const tokens=await response.json();assert.equal((await exchange(s,d)).status,400);
 const req=t=>new Request(base+'/mcp',{headers:{Authorization:'Bearer '+t}});assert.ok(await mcpIdentity(req(tokens.access_token),s));assert.equal(await mcpIdentity(new Request('https://other.example/mcp',{headers:{Authorization:'Bearer '+tokens.access_token}}),s),null);
 assert.ok(!JSON.stringify(await s.readStore()).includes(tokens.access_token));assert.ok(!JSON.stringify(await s.readStore()).includes(tokens.refresh_token));
 const refresh=()=>exchange(s,d,{grant_type:'refresh_token',refresh_token:tokens.refresh_token});const renewed=await refresh();assert.equal(renewed.status,200);assert.equal((await refresh()).status,400);
 await s.updateStore(x=>{x.mcpAuth.tokens=[];});assert.equal(await mcpIdentity(req(tokens.access_token),s),null);
});
test('consent rejects cross-site requests and missing CSRF nonce',async()=>{const s=makeStore(),d=await setup(s);const req=d.consent();const bad=new Request(req,{headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:'https://evil.example'}});assert.equal((await oauth(bad,env,s)).status,403);});
test('MCP SDK transport initializes, exposes tools, denies anonymous and enforces read-only scopes',async()=>{
 const s=makeStore(),d=await setup(s,'research:read'),t=await (await exchange(s,d)).json();
 assert.equal((await mcp(jsonRequest('/mcp',{}),s)).status,401);
 const call=async(method,params)=>{const r=await mcp(new Request(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+t.access_token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),s);assert.equal(r.status,200);return r.json();};
 const init=await call('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});assert.equal(init.result.serverInfo.name,'BanyanResearch');
 const list=await call('tools/list',{});assert.ok(list.result.tools.some(t=>t.name==='submit_research'));const result=await call('tools/call',{name:'get_research_context',arguments:{}});assert.ok(!result.result.isError);
 const denied=await call('tools/call',{name:'claim_research',arguments:{requestId:'testing-1'}});assert.equal(denied.result.isError,true);assert.ok(!JSON.stringify(result).includes('mcpAuth'));
});

test('MCP write tools complete a batch once and preserve source evidence',async()=>{
 const {initDots,queueDots}=await import('../lib/dots.js');const s=makeStore();await s.updateStore(x=>{initDots(x);x.dotsSettings.mode='dots';queueDots(x,[{id:'fixture-article',title:'Evidence',url:'https://example.com/paper'}],'fixture-job');});
 const d=await setup(s),token=await (await exchange(s,d)).json();
 const call=async(name,args)=>{const r=await mcp(new Request(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token.access_token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),s);const v=await r.json();assert.ok(!v.result.isError,JSON.stringify(v));return JSON.parse(v.result.content[0].text);};
 const batch=await call('claim_research',{requestId:'real-protocol-test'});
 const args={batchId:batch.id,leaseToken:batch.leaseToken,results:[{id:'fixture-article',summary:'Short assessment',topics:['ai'],problem:'Problem',method:'Method',conclusion:'Conclusion',rationale:'Useful engineering evidence',technicalGain:'Reproducible approach',evidence:'Author reports a small benchmark',limitations:'Not independently verified',researchQuestion:'',qualityScore:80,eventKey:'fixture',recommend:true,readingScope:'original_excerpt',relations:[]}]};
 const first=await call('submit_research',args);assert.equal(first.recommended,1);assert.deepEqual(await call('submit_research',args),first);const saved=await s.readStore();assert.equal(saved.recommendations.length,1);assert.equal(saved.recommendations[0].url,'https://example.com/paper');
});
