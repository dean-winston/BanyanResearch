import test from 'node:test';
import assert from 'node:assert/strict';
import {migrate} from '../lib/state.js';
import {applySettings,claimAgentCheck} from '../lib/settings.js';
test('older databases inherit collection settings; invalid updates are atomic',()=>{
 const s=migrate({settings:{maxArticlesPerRun:7}});assert.equal(s.settings.sourceArticleLimit,3);assert.equal(s.settings.collectionSinceDays,30);assert.equal(s.settings.maxArticlesPerRun,7);assert.equal(s.agentSettings.checkIntervalHours,1);
 const before=structuredClone(s.settings);assert.throws(()=>applySettings(s.settings,{sourceArticleLimit:10,collectionSinceDays:0}),/1–365/);assert.deepEqual(s.settings,before);
 for(const v of [0,21,1.5,'3',null])assert.throws(()=>applySettings(s.settings,{sourceArticleLimit:v}));
 applySettings(s.settings,{sourceArticleLimit:8,collectionSinceDays:90});assert.equal(s.settings.sourceArticleLimit,8);assert.equal(s.settings.collectionSinceDays,90);assert.equal(s.settings.maxArticlesPerRun,7);
});
test('scheduled checks honor persistent interval, role switches and duplicate ticks',()=>{
 const s=migrate(),at=Date.parse('2026-10-07T00:00:00Z');
 assert.equal(claimAgentCheck(s,at),false);s.agentSettings.enabled=true;s.agentSettings.checkIntervalHours=6;
 assert.equal(claimAgentCheck(s,at),true);assert.equal(claimAgentCheck(s,at),false);assert.equal(claimAgentCheck(s,at+5*3600000),false);
 const restarted=migrate(JSON.parse(JSON.stringify(s)));assert.equal(claimAgentCheck(restarted,at+6*3600000),true);
 restarted.agents.forEach(a=>a.enabled=false);assert.equal(claimAgentCheck(restarted,at+12*3600000),false);
});
