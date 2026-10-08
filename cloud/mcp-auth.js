import {equalSecrets,authenticated} from './auth.js';
const scopes=['research:read','research:write'];
const enc=new TextEncoder();
const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');
export const hash=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(v))),n=>n.toString(16).padStart(2,'0')).join('');
const challenge=async v=>btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(v))))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const json=(data,status=200,headers={})=>Response.json(data,{status,headers:{'Cache-Control':'no-store',...headers}});
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
function auth(s){s.mcpAuth||={clients:[],codes:[],tokens:[]};const a=s.mcpAuth,now=Date.now();a.codes=a.codes.filter(x=>x.expiresAt>now);a.tokens=a.tokens.filter(x=>x.expiresAt>now);return a;}
function redirectAllowed(v){try{const u=new URL(v);return u.origin==='https://chatgpt.com'&&!u.search&&!u.hash&&(u.pathname==='/connector_platform_oauth_redirect'||/^\/connector\/oauth\/[a-zA-Z0-9_-]+$/.test(u.pathname));}catch{return false;}}
export async function limitedBody(request,max=100000){const reader=request.body?.getReader();let total=0;const chunks=[];if(reader)try{while(true){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>max){await reader.cancel();fail('请求过大',413);}chunks.push(value);}}finally{reader.releaseLock();}const bytes=new Uint8Array(total);let pos=0;for(const c of chunks){bytes.set(c,pos);pos+=c.length;}return new TextDecoder().decode(bytes);}
function scopeList(v){const list=[...new Set((v||'research:read research:write').split(' ').filter(Boolean))];if(!list.length||list.some(s=>!scopes.includes(s)))fail('invalid_scope');return list;}
const escape=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function oauth(request,env,store){
 const url=new URL(request.url),origin=url.origin,path=url.pathname,resource=origin+'/mcp';
 try{
 if(path==='/.well-known/oauth-protected-resource'||path==='/.well-known/oauth-protected-resource/mcp')return json({resource,authorization_servers:[origin],scopes_supported:scopes,bearer_methods_supported:['header']});
 if(path==='/.well-known/oauth-authorization-server')return json({issuer:origin,authorization_endpoint:origin+'/oauth/authorize',token_endpoint:origin+'/oauth/token',registration_endpoint:origin+'/oauth/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],scopes_supported:scopes,authorization_response_iss_parameter_supported:true});
 if(!env.ADMIN_PASSWORD||!env.SESSION_SECRET)return json({error:'temporarily_unavailable'},503);
 if(path==='/oauth/register'&&request.method==='POST'){
  const d=JSON.parse(await limitedBody(request,8000));if(!Array.isArray(d.redirect_uris)||!d.redirect_uris.length||d.redirect_uris.length>5||d.redirect_uris.some(v=>!redirectAllowed(v)))fail('invalid_redirect_uri');
  if(d.token_endpoint_auth_method&&d.token_endpoint_auth_method!=='none')fail('仅支持 PKCE public client（none）');
  const client={client_id:random(),client_name:'ChatGPT / dots',redirect_uris:d.redirect_uris,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],createdAt:Date.now()};
  await store.updateStore(s=>{const a=auth(s);a.clients=a.clients.filter(c=>c.createdAt>Date.now()-90*86400000||a.tokens.some(t=>t.clientId===c.client_id));if(a.clients.length>=200)fail('注册数量已达上限',429);a.clients.push(client);});return json(client,201);
 }
 if(path==='/oauth/authorize'&&['GET','POST'].includes(request.method)){
  const p=url.searchParams,client=(await store.readStore()).mcpAuth?.clients.find(c=>c.client_id===p.get('client_id'));
  if(!client||!client.redirect_uris.includes(p.get('redirect_uri')))fail('invalid_client_or_redirect');
  if(p.get('response_type')!=='code'||p.get('code_challenge_method')!=='S256'||!/^[-\w]{43}$/.test(p.get('code_challenge')||''))fail('PKCE S256 required');
  if(p.get('resource')!==resource)fail('invalid_target');const requested=scopeList(p.get('scope'));
  if(request.method==='GET'){
   const nonce=random();const logged=await authenticated(request,env);
   const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><title>连接 dots · BanyanResearch</title><body><main class="login-screen"><form method="post" class="login-card"><h1>将榕树连接到 ChatGPT / dots</h1><p>允许读取你的文章、博客、项目摘要、研究问题与反馈。${requested.includes('research:write')?'允许领取研究任务、保存推荐、修改研究问题及阅读反馈。':''}</p><p>不会授予修改登录密码、读取模型密钥或删除数据库的权限。你可在“持续助手”页面断开授权。</p><input type="hidden" name="nonce" value="${nonce}">${logged?'': '<label>榕树访问密码<input name="password" type="password" autocomplete="current-password" required></label>'}<button class="button dark" name="decision" value="allow">授权连接</button><button class="button outline" name="decision" value="deny">取消</button></form></main></body></html>`;
   return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",'Referrer-Policy':'no-referrer','Set-Cookie':`__Host-banyan_oauth=${nonce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`}});
  }
  if(request.headers.get('Origin')!==origin)fail('授权来源无效',403);
  const form=new URLSearchParams(await limitedBody(request,10000));const cookie=request.headers.get('Cookie')?.match(/(?:^|;\s*)__Host-banyan_oauth=([a-f0-9]{64})(?:;|$)/)?.[1];if(!cookie||!await equalSecrets(cookie,form.get('nonce')||''))fail('授权页面已失效，请重新打开',403);
  const destination=new URL(p.get('redirect_uri'));if(p.has('state'))destination.searchParams.set('state',p.get('state'));destination.searchParams.set('iss',origin);
  if(form.get('decision')==='deny')destination.searchParams.set('error','access_denied');
  else{
   if(form.get('decision')!=='allow')fail('invalid_request');
   if(!await authenticated(request,env)){
    const allowed=await store.updateStore(s=>{const bucket=Math.floor(Date.now()/60000);if(s.loginAttempts?.bucket!==bucket)s.loginAttempts={bucket,count:0};return ++s.loginAttempts.count<=10;});
    if(!allowed)fail('登录尝试过多，请稍后再试',429);if(!await equalSecrets(form.get('password')||'',env.ADMIN_PASSWORD))fail('密码错误，请返回重试',401);
   }
   const code=random(),digest=await hash(code);
   await store.updateStore(s=>auth(s).codes.push({hash:digest,clientId:client.client_id,redirect:p.get('redirect_uri'),challenge:p.get('code_challenge'),resource,scopes:requested,expiresAt:Date.now()+5*60000}));destination.searchParams.set('code',code);
  }
  return new Response(null,{status:303,headers:{Location:destination.href,'Cache-Control':'no-store','Set-Cookie':'__Host-banyan_oauth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'}});
 }
 if(path==='/oauth/token'&&request.method==='POST'){
  const p=new URLSearchParams(await limitedBody(request,12000)),grant=p.get('grant_type');
  if(!['authorization_code','refresh_token'].includes(grant))fail('unsupported_grant_type');
  if(p.get('resource')!==resource)fail('invalid_target');
  const raw=p.get(grant==='authorization_code'?'code':'refresh_token')||'',digest=await hash(raw),access=random(),refresh=random();const accessHash=await hash(access),refreshHash=await hash(refresh);
  const proof=grant==='authorization_code'&&/^[A-Za-z0-9._~-]{43,128}$/.test(p.get('code_verifier')||'')?await challenge(p.get('code_verifier')):'';
  const result=await store.updateStore(s=>{
   const a=auth(s);if(!a.clients.some(c=>c.client_id===p.get('client_id')))fail('invalid_client',401);
   const entry=(grant==='authorization_code'?a.codes:a.tokens).find(t=>t.hash===digest&&t.clientId===p.get('client_id')&&t.resource===resource&&(grant==='authorization_code'||t.kind==='refresh'));
   if(!entry||grant==='authorization_code'&&(entry.redirect!==p.get('redirect_uri')||!proof||entry.challenge!==proof))fail('invalid_grant');
   const allowed=p.has('scope')?scopeList(p.get('scope')):entry.scopes;if(allowed.some(x=>!entry.scopes.includes(x)))fail('invalid_scope');
   if(grant==='authorization_code')a.codes=a.codes.filter(c=>c!==entry);else a.tokens=a.tokens.filter(t=>t!==entry);
   const common={clientId:entry.clientId,resource,scopes:allowed,owner:entry.owner||crypto.randomUUID()};
   a.tokens.push({...common,hash:accessHash,kind:'access',expiresAt:Date.now()+3600000},{...common,hash:refreshHash,kind:'refresh',expiresAt:Date.now()+30*86400000});a.lastConnectedAt=new Date().toISOString();return {access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:refresh,scope:allowed.join(' ')};
  });return json(result);
 }
 return json({error:'not_found'},404);
 }catch(e){return json({error:e.status?e.message:'invalid_request'},e.status||400);}
}
export async function mcpIdentity(request,store){const raw=request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];if(!raw)return null;const digest=await hash(raw);return (await store.readStore()).mcpAuth?.tokens.find(t=>t.hash===digest&&t.kind==='access'&&t.expiresAt>Date.now()&&t.resource===new URL('/mcp',request.url).href)||null;}
