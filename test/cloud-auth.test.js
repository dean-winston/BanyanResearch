import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionCookie,authenticated,equalSecrets} from '../cloud/auth.js';
const env={ADMIN_PASSWORD:'test-admin-password',SESSION_SECRET:'test-session-secret-long-and-random'};
const request=cookie=>new Request('https://example.com/api/state',{headers:cookie?{Cookie:cookie}:{}});
const token=async()=> (await sessionCookie(env,'https://example.com')).split(';')[0];

test('signed session authenticates and production cookie has strict transport protections',async()=>{
 const cookie=await sessionCookie(env,'https://example.com');
 for(const flag of ['HttpOnly','SameSite=Strict','Path=/','Max-Age=604800','Secure'])assert(cookie.includes(flag));
 assert.equal(await authenticated(request(cookie.split(';')[0]),env),true);
 assert.equal(await authenticated(request(),env),false);
 assert.equal(await authenticated(request(await token()),{SESSION_SECRET:env.SESSION_SECRET}),false);
 assert.equal(await authenticated(request(await token()),{ADMIN_PASSWORD:env.ADMIN_PASSWORD}),false);
});

test('tampered expiration, tampered signature and different signing secret fail authentication',async()=>{
 const cookie=await token();const [name,raw]=cookie.split('=');const [expiration,signature]=raw.split('.');
 assert.equal(await authenticated(request(`${name}=${Number(expiration)+1000}.${signature}`),env),false);
 assert.equal(await authenticated(request(`${name}=${expiration}.${signature[0]==='a'?'b':'a'}${signature.slice(1)}`),env),false);
 assert.equal(await authenticated(request(cookie),{...env,SESSION_SECRET:'different-secret'}),false);
});

test('expired and excessively future signed sessions fail even when signature is valid',async()=>{
 const original=Date.now,fixed=original();let old,future;
 try{Date.now=()=>fixed-8*86400000;old=await token();Date.now=()=>fixed+2*86400000;future=await token();}finally{Date.now=original;}
 assert.equal(await authenticated(request(old),env),false);assert.equal(await authenticated(request(future),env),false);
});

test('malformed sessions and appended token components are rejected',async()=>{
 for(const value of ['','abc','123','abc.deadbeef','999999999999999999999.deadbeef'])assert.equal(await authenticated(request(`pis_session=${value}`),env),false);
 assert.equal(await authenticated(request(`${await token()}.extra`),env),false);
});

test('password comparisons accept only exact values including Unicode and length',async()=>{
 assert.equal(await equalSecrets('correct','correct'),true);assert.equal(await equalSecrets('correct','wrong'),false);assert.equal(await equalSecrets('correct','correct '),false);assert.equal(await equalSecrets('密码','密码'),true);assert.equal(await equalSecrets('密码','密'),false);
});
