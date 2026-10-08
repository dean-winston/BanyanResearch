import test from 'node:test';
import assert from 'node:assert/strict';
import {migrate} from '../lib/state.js';
import {preferences,readingSourceOrder} from '../lib/reading.js';
import {selectDigest} from '../public/digest.js';
import {analyzeArticles} from '../lib/analyzer.js';

test('reading preference imports all 45 sources without overwriting user edits', () => {
  assert.equal(preferences.sources.length,45);
  assert.equal(new Set(preferences.sources.map(source => source.id)).size,45);
  assert(preferences.sources.every(source => ['blogger','company','news'].includes(source.type)));
  const source = {id:'mine',name:'Simon Willison',url:'https://simonwillison.net/',enabled:false,notes:'我的备注',feedUrl:'https://simonwillison.net/custom'};
  const store = migrate({sources:[source]});
  assert.equal(store.sources.filter(item => item.name === source.name).length,1);
  assert.equal(source.enabled,false);
  assert.equal(source.notes,'我的备注');
  assert.equal(source.feedUrl,'https://simonwillison.net/custom');
  assert.equal(source.sourceKind,'工程实践作者');
  const count=store.sources.length;
  migrate(store);
  assert.equal(store.sources.length,count);
  store.sources=[];
  migrate(store);
  assert.equal(store.sources.length,0);
});

test('discovery budget includes official and news without letting news dominate', () => {
  const sources=preferences.sources;
  const ordered=readingSourceOrder(sources);
  assert.equal(ordered.length,sources.length);
  assert.deepEqual(ordered.slice(0,4).map(source => source.sourceGroup),['research','research','official','news']);
});

test('digest selects at most five recent qualified items and merges matching events', () => {
  const item = (id,qualityScore,extra={}) => ({id,url:'https://example.com/'+id,createdAt:'2026-10-08T00:00:00Z',qualityScore,analysisVersion:'ai-reading-v1',...extra});
  const items=[item('best',99,{eventKey:'model-x'}),item('duplicate',98,{eventKey:'MODEL-X'}),item('old',100,{createdAt:'2026-10-07T00:00:00Z'}),item('stale',100,{stale:true}),item('ignored',100,{feedback:'irrelevant'}),item('legacy',100,{analysisVersion:'personal-v1'}),...Array.from({length:8},(_,index)=>item('other'+index,80-index))];
  const digest=selectDigest(items);
  assert.equal(digest.length,5);
  assert.equal(digest[0].id,'best');
  assert(!digest.some(entry => ['duplicate','old','stale','ignored','legacy'].includes(entry.id)));
  assert.deepEqual(selectDigest([]),[]);
});

test('analysis uses reading taste independently of personal links and gates low quality', async () => {
  const store=migrate();
  const article={id:'paper',title:'Agent evaluation',url:'https://example.com/paper',excerpt:'Technical methods and experiments',sourceKind:'工程实践作者',readingScope:'original_excerpt'};
  const runner=async (task,data,schema)=>{
    assert.match(task,/个人资料关联是加分项而非入选前提/);
    assert.match(task,/失败恢复/);
    assert.equal(data.articles[0].readingScope,'original_excerpt');
    assert(schema.properties.results.items.required.includes('qualityScore'));
    return {results:[{id:'paper',summary:'验证器、失败恢复与评测方法',rationale:'可借鉴的系统设计',qualityScore:65,eventKey:'agent-evaluation',recommend:true,relations:[]}]};
  };
  const [result]=await analyzeArticles([article],store,runner);
  assert.equal(result.recommend,false);
  assert.equal(result.readingScope,'original_excerpt');
  const [saved]=await analyzeArticles([{...article,summary:'之前生成的摘要'}],store,async (task,data)=>{
    assert.equal(data.articles[0].readingScope,'saved_summary');
    return {results:[{id:'paper',summary:'有证据的工程分析',rationale:'方法可复用',qualityScore:95,eventKey:'agent-evaluation',recommend:true,relations:[]}]};
  });
  assert.equal(saved.recommend,true);
  assert.equal(saved.relations.length,0);
  assert.equal(saved.readingScope,'saved_summary');
});
