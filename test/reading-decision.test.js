import test from 'node:test';
import assert from 'node:assert/strict';
import {readingDecision} from '../public/digest.js';
import {renderReadingDecision,readingCard} from '../public/reading-view.js';
import {applyRecommendationFeedback} from '../lib/feedback.js';
import {saveAnalyzedArticles} from '../lib/jobs.js';

const job={id:'current',type:'collect',status:'success',createdAt:'2026-10-08T08:00:00Z',startedAt:'2026-10-08T08:00:00Z',finishedAt:'2026-10-08T08:10:00Z',errors:[]};
const recommendation=(id,extra={})=>({id,articleId:'article-'+id,sourceId:'enabled',sourceName:'Fixture',url:'https://example.com/'+id,title:id,summary:'方法摘要',rationale:'可以借鉴验证方法',analysisVersion:'ai-reading-v2',qualityScore:90,jobId:'current',createdAt:'2026-10-07T08:00:00Z',updatedAt:'2026-10-08T08:05:00Z',...extra});
const store=(recommendations=[],extra={})=>({recommendations,articles:[],sources:[{id:'enabled',name:'Fixture',enabled:true}],jobs:[job],...extra});

test('current round uses job identity rather than old creation date or yesterday digest',()=>{
 const current=recommendation('reanalysed');
 const old=recommendation('old',{jobId:'previous',qualityScore:99});
 const decision=readingDecision(store([current,old]));
 assert.deepEqual(decision.digest.map(item=>item.id),['reanalysed']);
 assert.equal(decision.history.length,2);
 assert.equal(decision.status,'ready');
 assert.equal(readingDecision(store([old])).status,'empty');
});

test('disabled sources are excluded using article metadata while historical records remain',()=>{
 const item=recommendation('disabled',{sourceId:undefined,sourceName:undefined});
 const decision=readingDecision(store([item],{articles:[{id:item.articleId,sourceId:'off'}],sources:[{id:'off',enabled:false}]}));
 assert.equal(decision.digest.length,0);
 assert.equal(decision.disabledCount,1);
 assert.equal(decision.history.length,1);
 assert.match(readingCard(decision.history[0],{history:true,sources:[{id:'off',enabled:false}]}),/来源已停用/);
});

test('running, failed, partial, empty and legacy states have distinct honest conclusions',()=>{
 for(const [status,expected] of [['running','running'],['queued','running'],['failed','failed'],['interrupted','failed'],['partial','partial'],['success','empty']])assert.equal(readingDecision(store([],{jobs:[{...job,status}]})).status,expected);
 assert.match(renderReadingDecision(store([],{jobs:[{...job,status:'failed'}]})).html,/不能据此判断没有好内容/);
 assert.equal(readingDecision(store([recommendation('legacy',{analysisVersion:'personal-v1'})])).status,'needs_analysis');
 assert.equal(readingDecision(store([],{jobs:[]})).status,'not_started');
 assert.equal(readingDecision(store([recommendation('old',{analysisVersion:'personal-v1'})],{jobs:[]})).status,'needs_analysis');
});

test('source coverage counts only this task window and enabled sources',()=>{
 const sources=[{id:'now',enabled:true,lastCollection:{at:'2026-10-08T08:05:00Z',status:'error'}},{id:'old',enabled:true,lastCollection:{at:'2026-10-07T08:05:00Z',status:'success'}},{id:'off',enabled:false,lastCollection:{at:'2026-10-08T08:05:00Z',status:'error'}}];
 const decision=readingDecision(store([],{sources,jobs:[{...job,status:'partial',errors:['network']}]}));
 assert.equal(decision.checked,1);
 assert.equal(decision.failures,1);
 assert.equal(decision.errorCount,1);
});

test('decision cards show evidence boundaries, escape untrusted data and avoid duplicated first pick',()=>{
 const item=recommendation('<script>alert(1)</script>',{url:'javascript:alert(1)',evidence:'厂商自报，未独立验证',limitations:'仅测试了短任务',researchQuestion:'如何验证长任务恢复？'});
 const {html}=renderReadingDecision(store([item]));
 assert(!html.includes('<script>'));
 assert(!html.includes('href="javascript:'));
 assert.match(html,/技术增量/);
 assert.match(html,/厂商自报/);
 assert.match(html,/仅测试了短任务/);
 assert.match(html,/值得深挖的问题/);
 assert.equal((html.match(/class="recommend-card reading-card/g)||[]).length,1);
 assert.match(readingCard(recommendation('legacy')),/未单独记录实验证据/);
});

test('feedback reason validation is atomic and reset clears reason',()=>{
 const state=store([recommendation('feedback')]);
 applyRecommendationFeedback(state,'feedback',{feedback:'irrelevant',feedbackReason:'depth'});
 assert.equal(state.recommendations[0].feedbackReason,'depth');
 assert.throws(()=>applyRecommendationFeedback(state,'feedback',{feedback:'useful',feedbackReason:'invented'}),/无效/);
 assert.equal(state.recommendations[0].feedback,'irrelevant');
 applyRecommendationFeedback(state,'feedback',{feedback:'new'});
 assert.equal(state.recommendations[0].feedbackReason,'');
 assert.throws(()=>applyRecommendationFeedback(state,'missing',{feedback:'useful'}),/不存在/);
});

test('saved reading judgment keeps provenance and never stores original excerpts',()=>{
 const state=store([]);
 const candidate={id:'article',title:'Harness',url:'https://example.com/harness',sourceId:'enabled',excerpt:'PRIVATE ORIGINAL BODY'};
 const analysis={id:'article',summary:'摘要',recommend:true,technicalGain:'外置检查点',evidence:'作者实验',limitations:'未测长任务',researchQuestion:'如何恢复？',relations:[]};
 saveAnalyzedArticles(state,[candidate],[analysis],{jobId:'current'});
 const saved=state.recommendations[0];
 assert.equal(saved.jobId,'current');
 assert.equal(saved.sourceId,'enabled');
 assert.equal(saved.evidence,'作者实验');
 assert(!JSON.stringify(state).includes('PRIVATE ORIGINAL BODY'));
 applyRecommendationFeedback(state,saved.id,{feedback:'irrelevant',feedbackReason:'evidence'});
 saveAnalyzedArticles(state,[candidate],[analysis],{jobId:'next'});
 assert.equal(state.recommendations[0].feedbackReason,'evidence');
});
