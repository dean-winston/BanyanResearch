import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pis-jobs-test-'));
process.env.DATA_DIR=dir;
const {readStore,updateStore,initializeStore}=await import('../lib/store.js');
const {createJobRunner,canonicalUrl,saveAnalyzedArticles}=await import('../lib/jobs.js');
const {analyzeArticles,referenceContext}=await import('../lib/analyzer.js');
test.after(()=>fs.rm(dir,{recursive:true,force:true}));
const result=a=>({id:a.id,summary:'短摘要',topics:['ai'],problem:'问题',method:'方法',conclusion:'结论',rationale:'与当前研究相关',recommend:true,relations:[]});
test('daily pipeline stores own full blog but never external body; repeated runs deduplicate and preserve feedback',async()=>{
 await updateStore(s=>{s.sources=[{id:'s1',name:'Fixture',enabled:true},{id:'s2',name:'Disabled',enabled:false}];});
 let collections=0;
 const deps={syncBlog:async()=>({articles:[{id:'blog1',title:'我的 Agent',url:'https://example.org/own',content:'OWN FULL BLOG',sha:'sha1',topics:['ai']}],warnings:[]}),analyzeBlogs:async blogs=>blogs.map(b=>({id:b.id,summary:'自己的研究',topics:['ai'],questions:['如何评估 Agent？']})),collectSource:async s=>{collections++;return {status:'success',articles:[{title:'Evidence',url:'https://example.com/post?utm_source=x',excerpt:'EXTERNAL FULL BODY MUST NEVER BE STORED',content:'also never',publishedAt:new Date().toISOString(),topics:['ai']}]};},analyzeArticles:async articles=>articles.map(result)};
 const runner=createJobRunner(deps);await runner.enqueue('daily');await runner.idle();
 let state=await readStore();assert.equal(state.jobs[0].status,'success');assert.equal(state.blogs[0].content,'OWN FULL BLOG');assert.equal(state.articles.length,1);assert.equal(state.recommendations.length,1);assert.equal(state.questions[0].status,'paused');assert.equal(state.articles[0].url,'https://example.com/post');assert.equal(collections,1);
 assert.doesNotMatch(await fs.readFile(path.join(dir,'knowledge.json'),'utf8'),/EXTERNAL FULL BODY|also never/);
 await updateStore(s=>{s.recommendations[0].feedback='useful';s.questions[0].notes='人工修改';s.questions[0].status='resolved';});
 await runner.enqueue('daily');await runner.idle();state=await readStore();assert.equal(state.articles.length,1);assert.equal(state.questions.length,1);assert.equal(state.questions[0].notes,'人工修改');assert.equal(state.recommendations[0].feedback,'useful');
});
test('mixed source failures become partial and duplicate queued requests share one task',async()=>{
 const runner=createJobRunner({collectSource:async()=>({status:'error',articles:[],error:'fixture network unavailable'})});
 const first=await runner.enqueue('collect'),second=await runner.enqueue('collect');assert.equal(first.id,second.id);await runner.idle();const state=await readStore();const job=state.jobs.find(j=>j.id===first.id);assert.equal(job.status,'partial');assert.match(job.errors[0],/fixture network/);
});
test('repo inventory keeps fork but analyses only owned repos with evidence',async()=>{
 const runner=createJobRunner({syncRepositories:async()=>({repositories:[{id:'original',name:'Original',url:'https://github.com/u/o',fork:false},{id:'fork',name:'Fork',fork:true}],warnings:[]}),getRepositoryEvidence:async r=>{assert.equal(r.fork,false);return {sha:'commit',files:[{path:'main.js',url:'https://github.com/u/o/blob/commit/main.js',content:'CODE'}]};},analyzeRepository:async()=>({card:{viewpoint:'明确证据',inference:true,evidence:[]},questions:[]})});
 await runner.enqueue('repositories');await runner.idle();const s=await readStore();assert.equal(s.repositories.find(r=>r.id==='fork').analysisStatus,'excluded');assert.equal(s.repositories.find(r=>r.id==='original').sha,'commit');assert.doesNotMatch(await fs.readFile(path.join(dir,'knowledge.json'),'utf8'),/"content": "CODE"/);
});
test('analysis drops invented references and excludes resolved questions from active context',async()=>{
 const s=await readStore();assert.ok(!referenceContext(s).some(r=>r.kind==='question'));
 const a={id:'a',title:'article',url:'https://example.com/a'};
 const results=await analyzeArticles([a],s,async()=>({results:[{...result(a),relations:[{referenceId:'blog:blog1',reason:'valid'},{referenceId:'forged',reason:'invented'}]}]}));assert.equal(results[0].relations.length,1);assert.equal(results[0].relations[0].id,'blog1');
});
test('restart marks unfinished jobs interrupted and preserves existing knowledge',async()=>{
 await updateStore(s=>{s.items.push({id:'keep',content:'original note'});s.jobs.unshift({id:'interrupted',status:'running'});});await initializeStore();const s=await readStore();assert.equal(s.jobs[0].status,'interrupted');assert.ok(s.items.some(i=>i.id==='keep'));
});
test('canonical URL removes tracking but retains semantic query',()=>{assert.equal(canonicalUrl('https://example.com/a?utm_source=x&page=2#top'),'https://example.com/a?page=2');assert.throws(()=>canonicalUrl('javascript:alert(1)'));});
test('changed blog whose analysis fails is retried next time and never uses stale summary',async()=>{
 await updateStore(s=>{s.blogs=[{id:'retry',sha:'old',analyzedSha:'old',summary:'STALE',content:'old'}];});
 let attempts=0;
 const runner=createJobRunner({syncBlog:async()=>({articles:[{id:'retry',sha:'new',title:'更新文章',content:'new content',url:'https://example.org/new'}],warnings:[]}),analyzeBlogs:async()=>{attempts++;if(attempts===1)throw new Error('transient');return [{id:'retry',summary:'fresh summary',topics:['ai'],questions:[]}];}});
 await runner.enqueue('blog');await runner.idle();assert.equal((await readStore()).blogs[0].summary,'');
 await runner.enqueue('blog');await runner.idle();assert.equal(attempts,2);assert.equal((await readStore()).blogs[0].summary,'fresh summary');
});
test('reselected recommendation clears stale flag while preserving feedback',()=>{
 const s={articles:[],recommendations:[]},a={id:'reselect',title:'A',url:'https://example.org/a'};
 saveAnalyzedArticles(s,[a],[result(a)]);s.recommendations[0].feedback='later';
 saveAnalyzedArticles(s,[a],[{...result(a),recommend:false}]);assert.equal(s.recommendations[0].stale,true);
 saveAnalyzedArticles(s,[a],[result(a)]);assert.equal(s.recommendations[0].stale,false);assert.equal(s.recommendations[0].feedback,'later');
});
test('failed repository cannot starve never-analyzed projects under run budget',async()=>{
 await updateStore(s=>{s.settings.maxRepoAnalysesPerRun=1;s.repositories=[{id:'bad',name:'Bad',fork:false,analysisStatus:'failed',lastAttemptAt:'2026-01-01'},{id:'new',name:'New',fork:false,analysisStatus:'pending'}];});
 let chosen;
 const runner=createJobRunner({syncRepositories:async()=>({repositories:[],warnings:[]}),getRepositoryEvidence:async repo=>{chosen=repo.id;return {sha:'s',files:[{path:'README.md'}]};},analyzeRepository:async()=>({card:{viewpoint:'v',evidence:[]},questions:[]})});
 await runner.enqueue('repositories');await runner.idle();assert.equal(chosen,'new');
});
test('daily rematches older articles after blog context changes within remaining article budget',async()=>{
 await updateStore(s=>{s.articles=[{id:'older',title:'Existing article',url:'https://example.org/old',summary:'摘要'}];s.recommendations=[];s.sources=[{id:'one',name:'One',enabled:true}];s.blogs=[];s.settings.maxArticlesPerRun=2;});
 const seen=[];
 const runner=createJobRunner({syncBlog:async()=>({articles:[{id:'context',title:'新研究',sha:'v1',content:'新研究全文',url:'https://example.org/blog'}],warnings:[]}),analyzeBlogs:async()=>[{id:'context',summary:'新的研究方向',topics:['ai'],questions:[]}],collectSource:async()=>({status:'empty',articles:[]}),analyzeArticles:async (articles,store)=>{assert.equal(store.blogs[0].summary,'新的研究方向');seen.push(...articles.map(a=>a.id));return articles.map(result);}});
 await runner.enqueue('daily');await runner.idle();assert.deepEqual(seen,['older']);assert.equal((await readStore()).recommendations.length,1);
});
test('re-extracting candidate questions updates stable source slots without duplicate cards or overwriting confirmed questions',async()=>{
 const {addQuestionCandidates}=await import('../lib/jobs.js');const s={questions:[]};
 addQuestionCandidates(s,['如何验证接口？'],'blog','https://example.org/blog',['ai']);const id=s.questions[0].id;
 addQuestionCandidates(s,['怎样评估接口契约？'],'blog','https://example.org/blog',['ai']);assert.equal(s.questions.length,1);assert.equal(s.questions[0].id,id);
 s.questions[0].humanEdited=true;s.questions[0].status='active';
 addQuestionCandidates(s,['新的生成文本'],'blog','https://example.org/blog',['ai']);assert.equal(s.questions[0].title,'怎样评估接口契约？');
});

test('collection uses editable per-source count and lookback, including fourth candidate',async()=>{
 await updateStore(s=>{s.sources=[{id:'settings-fixture',name:'Fixture',enabled:true}];s.settings.sourceArticleLimit=4;s.settings.collectionSinceDays=90;s.settings.maxArticlesPerRun=4;});
 let received;
 const runner=createJobRunner({collectSource:async(source,options)=>{received=options;return {status:'success',articles:Array.from({length:4},(_,i)=>({title:'Editable limit fixture '+i,url:'https://example.com/editable-limit/'+i,excerpt:'Short evidence',publishedAt:new Date().toISOString()}))};},analyzeArticles:async articles=>articles.map(result)});
 await runner.enqueue('collect');await runner.idle();assert.deepEqual(received,{limit:4,sinceDays:90});const s=await readStore();assert.equal(s.articles.filter(a=>a.url.includes('/editable-limit/')).length,4);
});
test('daily update still collects external articles when blog provider is unavailable',async()=>{
 await updateStore(s=>{s.sources=[{id:'daily-source',name:'Daily',enabled:true}];});
 let collected=false;
 const runner=createJobRunner({collectionConcurrency:1,syncBlog:async()=>{throw new Error('HTTP 403 GitHub');},collectSource:async()=>{collected=true;return {status:'empty',articles:[]};},analyzeArticles:async items=>items.map(result)});
 const job=await runner.enqueue('daily');await runner.idle();
 const saved=(await readStore()).jobs.find(j=>j.id===job.id);
 assert.equal(collected,true);assert.equal(saved.status,'partial');assert.match(saved.errors[0],/博客同步.*403/);
});
