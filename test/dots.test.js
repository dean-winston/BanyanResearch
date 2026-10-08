import test from 'node:test';
import assert from 'node:assert/strict';
import {migrate} from '../lib/state.js';
import {initDots,queueDots,claimDots,submitDots,dotsStatus} from '../lib/dots.js';
const now=Date.parse('2026-10-09T02:00:00Z');
const state=()=>{const s=initDots(migrate({sources:[{id:'source',enabled:true}],readingPreferencesVersion:999}));s.dotsSettings.mode='dots';return s;};
const articles=n=>Array.from({length:n},(_,i)=>({id:'a'+i,title:'Article '+i,url:'https://example.com/'+i,sourceId:'source',excerpt:'DO NOT PERSIST EXTERNAL BODY'}));
const result=a=>({id:a.id,summary:'摘要',topics:['ai'],problem:'问题',method:'方法',conclusion:'结论',rationale:'理由',technicalGain:'技术增量',evidence:'作者报告了实验，未独立验证',limitations:'样本较小',researchQuestion:'',qualityScore:80,eventKey:'',recommend:true,readingScope:'original_excerpt',relations:[]});
const submission=b=>({batchId:b.id,leaseToken:b.leaseToken,results:b.articles.map(result)});
test('metadata-only queue, bounded claims and retry-safe submissions preserve feedback',()=>{
 const s=state();queueDots(s,articles(3),'job');queueDots(s,articles(3),'job');assert.equal(s.dotsQueue.length,3);assert.ok(!JSON.stringify(s).includes('DO NOT PERSIST'));
 const b=claimDots(s,{requestId:'request-1'},'owner',now);assert.deepEqual(claimDots(s,{requestId:'request-1'},'owner',now),b);assert.equal(claimDots(s,{requestId:'request-2'},'owner',now).status,'empty');
 assert.throws(()=>submitDots(s,submission(b),'other',now));assert.throws(()=>submitDots(s,{...submission(b),results:[result(b.articles[0])]},'owner',now));
 const receipt=submitDots(s,submission(b),'owner',now);s.recommendations[0].feedback='useful';assert.deepEqual(submitDots(s,submission(b),'owner',now),receipt);assert.equal(s.recommendations.length,3);assert.equal(s.jobs.length,1);assert.equal(s.recommendations[0].analysisMode,'dots');assert.equal(s.recommendations[0].feedback,'useful');
 assert.ok(!JSON.stringify(dotsStatus(s)).includes(b.leaseToken));
});
test('expired leases cannot submit; next claim requeues and invalidates previous holder',()=>{
 const s=state();queueDots(s,articles(1),'job');const b=claimDots(s,{requestId:'request-1'},'owner',now);assert.throws(()=>submitDots(s,submission(b),'owner',now+3*3600000));
 const next=claimDots(s,{requestId:'request-2'},'owner',now+3*3600000);assert.equal(next.articles.length,1);assert.notEqual(next.leaseToken,b.leaseToken);assert.throws(()=>submitDots(s,submission(b),'owner',now+3*3600000));assert.equal(submitDots(s,submission(next),'owner',now+3*3600000).processed,1);
});
test('daily limits apply across batches and recommendations without reading original are refused',()=>{
 const s=state();s.dotsSettings.maxArticlesPerDay=4;s.dotsSettings.maxRecommendationsPerDay=1;queueDots(s,articles(6),'job');const b=claimDots(s,{requestId:'request-1',limit:2},'owner',now);const d=submission(b);assert.throws(()=>submitDots(s,d,'owner',now));d.results[1].recommend=false;d.results[0].readingScope='feed_summary';assert.throws(()=>submitDots(s,d,'owner',now));d.results[0].readingScope='original_excerpt';submitDots(s,d,'owner',now);
 const b2=claimDots(s,{requestId:'request-2',limit:10},'owner',now);assert.equal(b2.articles.length,2);assert.throws(()=>submitDots(s,submission(b2),'owner',now));assert.equal(claimDots(s,{requestId:'request-3'},'owner',now).reason,'daily_limit');
});
test('switching away pauses claims and unfinished submissions',()=>{const s=state();queueDots(s,articles(1),'job');const b=claimDots(s,{requestId:'request-1'},'owner',now);s.dotsSettings.mode='builtin';assert.throws(()=>claimDots(s,{requestId:'request-2'},'owner',now));assert.throws(()=>submitDots(s,submission(b),'owner',now));});
