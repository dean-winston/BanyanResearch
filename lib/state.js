import seeds from '../data/sources.seed.json' with {type:'json'};
import {mergeReadingSources,preferences} from './reading.js';
export {seeds};
export const defaultSettings={dailyEnabled:true,maxArticlesPerRun:15,sourceArticleLimit:3,collectionSinceDays:30,maxRepoAnalysesPerRun:5,lastDailyAt:new Date().toISOString()};
export const defaultAgentSettings={enabled:false,checkIntervalHours:1,wakeIntervalHours:24,maxDecisionsPerDay:3,maxActionsPerDay:6};
export function migrate(store={}){
 for(const field of ['items','answers','articles','recommendations','blogs','repositories','questions','jobs','agentEvents','agentDecisions'])if(!Array.isArray(store[field]))store[field]=[];
 if(!Array.isArray(store.sources))store.sources=structuredClone(seeds);
 if(store.readingPreferencesVersion!==preferences.version){mergeReadingSources(store.sources);store.readingPreferencesVersion=preferences.version;}
 store.settings={...defaultSettings,...store.settings};store.agentSettings={...defaultAgentSettings,...store.agentSettings};
 if(!Array.isArray(store.agents))store.agents=[
  {id:'research',name:'研究 Agent',goal:'持续关注 AI、游戏开发和服务端信息，关联我的研究问题，形成有证据的推荐。',enabled:true},
  {id:'writing',name:'思想 Agent',goal:'跟进我的博客新增和修改，维护研究主题与候选问题，保留人工确认。',enabled:true},
  {id:'engineering',name:'工程 Agent',goal:'按我的手动要求分析非 Fork 仓库，保留工程观点与代码证据，不持续监听仓库。',enabled:false}
 ].map(a=>({...a,status:'idle',memory:'',lastWakeAt:'',nextWakeAt:'',lastAction:'',lastReason:'',error:''}));
 store.agentUsage ||= {date:'',decisions:0,actions:0};store.schemaVersion=4;return store;
}
