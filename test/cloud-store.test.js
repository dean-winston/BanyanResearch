import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createCloudStore, MAX_ENTITY_BYTES } from '../cloud/store.js';
import { publicURL, isPublicAddress, fetchText } from '../cloud/network.js';

// Execute the actual SQLite SQL behind the D1 binding interface, including
// batch transactions, CAS conditions, JSON bulk statements and rollback.
function binding() {
  const sql = new DatabaseSync(':memory:');
  const db = {
    sql, batches: [], beforeBatch: null,
    withSession(mode) { assert.equal(mode,'first-primary'); return this; },
    prepare(query) {
      let parameters=[];
      const stmt={ query,
        bind(...values) { parameters=values;return this; },
        execute() { const info=sql.prepare(query).run(...parameters);return {success:true,meta:{changes:Number(info.changes)}}; },
        async run() {return this.execute();},
        async all() {return {success:true,results:sql.prepare(query).all(...parameters)};},
      };return stmt;
    },
    async batch(statements) {
      db.beforeBatch?.(statements);
      db.batches.push(statements.length);
      sql.exec('BEGIN');
      try {const result=statements.map(statement=>statement.execute());sql.exec('COMMIT');return result;}
      catch(error){sql.exec('ROLLBACK');throw error;}
    },
  }; return db;
}

test('cloud entity store initializes once, preserves full text, ordering, deletion and running jobs',async()=>{
  const db=binding(),store=createCloudStore({DB:db});
  const initial=await store.readStore();assert(initial.sources.length>0);
  await store.updateStore(s=>{s.blogs=[{id:'one',content:'博客全文'},{id:'two',content:'另一篇'}];s.jobs=[{id:'job',status:'running'}];s.settings.maxArticlesPerRun=7;});
  const reopened=createCloudStore({DB:db});await reopened.initializeStore();
  assert.equal((await reopened.readStore()).jobs[0].status,'running');
  await reopened.updateStore(s=>{s.blogs.reverse();s.blogs.unshift({id:'three',content:'新增'});s.sources=[];});
  const final=await store.readStore();
  assert.deepEqual(final.blogs.map(b=>b.id),['three','two','one']);assert.equal(final.blogs[2].content,'博客全文');assert.equal(final.settings.maxArticlesPerRun,7);assert.deepEqual(final.sources,[]);
  await store.updateStore(s=>{s.blogs=s.blogs.filter(b=>b.id!=='two');});
  assert.deepEqual((await store.readStore()).blogs.map(b=>b.id),['three','one']);
  db.sql.close();
});

test('independent Worker stores retry CAS conflicts without losing either mutation',async()=>{
  const db=binding(),a=createCloudStore({DB:db}),b=createCloudStore({DB:db});await Promise.all([a.initializeStore(),b.initializeStore()]);
  let calls=0;
  await Promise.all([a.updateStore(async s=>{calls++;await Promise.resolve();s.questions.push({id:'a',title:'A'});}),b.updateStore(async s=>{calls++;await Promise.resolve();s.questions.push({id:'b',title:'B'});})]);
  assert.deepEqual(new Set((await a.readStore()).questions.map(q=>q.id)),new Set(['a','b']));assert(calls>=3);
  db.sql.close();
});

test('CAS failure is bounded to three retries and no gated entity mutation leaks',async()=>{
  const db=binding(),store=createCloudStore({DB:db});await store.initializeStore();let attempts=0;
  db.beforeBatch=statements=>{if(statements[0].query.startsWith('UPDATE app_meta')){attempts++;db.sql.exec('UPDATE app_meta SET revision=revision+1 WHERE id=1');}};
  await assert.rejects(store.updateStore(s=>{s.questions.push({id:'never',title:'Must not persist'});}),error=>error.code==='STATE_CONFLICT');
  assert.equal(attempts,4);assert.equal((await store.readStore()).questions.length,0);db.sql.close();
});

test('history can exceed one D1 row, oversized single record fails without overwriting',async()=>{
  const db=binding(),store=createCloudStore({DB:db});await store.initializeStore();
  await store.updateStore(s=>{s.blogs=[{id:'a',content:'x'.repeat(1_100_000)},{id:'b',content:'y'.repeat(1_100_000)}];});
  assert.equal((await store.readStore()).blogs.length,2);
  await assert.rejects(store.updateStore(s=>{s.blogs[0].content='z'.repeat(MAX_ENTITY_BYTES);}),error=>error.code==='ENTITY_CAPACITY');
  assert.equal((await store.readStore()).blogs[0].content.length,1_100_000);db.sql.close();
});

test('bulk entity writes and reordering remain a few SQL statements for hundreds of rows',async()=>{
  const db=binding(),store=createCloudStore({DB:db});await store.initializeStore();
  await store.updateStore(s=>{s.articles=Array.from({length:500},(_,i)=>({id:String(i),title:`Article ${i}`}));});
  await store.updateStore(s=>{s.articles.unshift({id:'new',title:'New'});});
  assert(db.batches.at(-1)<=4);assert.equal((await store.readStore()).articles[500].id,'499');db.sql.close();
});

test('cloud URL guard handles normalized numeric IPs, IPv6, trailing dots and internal names',()=>{
  for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::'])assert.equal(isPublicAddress(address),false,address);
  for(const address of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111'])assert.equal(isPublicAddress(address),true,address);
  for(const url of ['http://localhost.','http://foo.internal','http://2130706433','http://[::1]','file:///etc/passwd','https://user:pass@example.com'])assert.throws(()=>publicURL(url));
});

test('cloud fetch rejects private DNS and private redirect without fetching destination',async()=>{
  const original=globalThis.fetch;const seen=[];
  try{
    globalThis.fetch=async url=>{seen.push(String(url));return Response.json({Status:0,Answer:[{type:1,data:'127.0.0.1'}]});};
    await assert.rejects(fetchText('https://example.com'),/非公开/);assert(seen.every(url=>url.startsWith('https://cloudflare-dns.com/')));
    seen.length=0;
    globalThis.fetch=async url=>{seen.push(String(url));return new Response(null,{status:302,headers:{location:'http://169.254.169.254/'}});};
    await assert.rejects(fetchText('https://1.1.1.1'),/内网/);assert.equal(seen.length,1);
  }finally{globalThis.fetch=original;}
});

test('cloud fetch bounds body, retries transient once, and strips credentials across origins',async()=>{
  const original=globalThis.fetch;
  try{
    let calls=0;globalThis.fetch=async()=>++calls===1?new Response(null,{status:503}):new Response('ok');
    assert.equal(await fetchText('https://1.1.1.1/'),'ok');assert.equal(calls,2);
    calls=0;globalThis.fetch=async()=>{calls++;return new Response(null,{status:403});};
    await assert.rejects(fetchText('https://1.1.1.1/'),/403/);assert.equal(calls,1);
    globalThis.fetch=async()=>new Response('too long');await assert.rejects(fetchText('https://1.1.1.1/',{maxBytes:3}),/字节/);
    calls=0;globalThis.fetch=async(url,options)=>{if(++calls===1)return new Response(null,{status:302,headers:{location:'https://8.8.8.8/'}});assert.equal(options.headers.get('Authorization'),null);return new Response('redirected');};
    assert.equal(await fetchText('https://1.1.1.1/',{headers:{Authorization:'secret'}}),'redirected');
  }finally{globalThis.fetch=original;}
});

test('Workers DNS and page requests use supported redirect mode and DNS redirects are refused',async()=>{
 const original=globalThis.fetch;
 try{
  let pages=0;
  globalThis.fetch=async(url,options)=>{
   assert.equal(options.redirect,'manual');
   if(String(url).startsWith('https://cloudflare-dns.com/'))return Response.json({Status:0,Answer:[{type:1,data:'1.1.1.1'}]});
   pages++;return new Response('reachable');
  };
  assert.equal(await fetchText('https://example.com/'),'reachable');assert.equal(pages,1);
  globalThis.fetch=async(url,options)=>{assert.equal(options.redirect,'manual');assert.ok(String(url).startsWith('https://cloudflare-dns.com/'));return new Response(null,{status:302,headers:{location:'https://untrusted.example/'}});};
  await assert.rejects(fetchText('https://example.com/'),/DNS/);
 }finally{globalThis.fetch=original;}
});
