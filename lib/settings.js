const ranges={maxArticlesPerRun:[1,100,'每轮分析文章数'],maxRepoAnalysesPerRun:[1,20,'每轮分析项目数'],sourceArticleLimit:[1,20,'每个来源候选篇数'],collectionSinceDays:[1,365,'采集时间范围']};
export function applySettings(current,input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Object.assign(new Error('设置无效'),{status:400});
 const next={...current};
 if(input.dailyEnabled!==undefined){if(typeof input.dailyEnabled!=='boolean')throw Object.assign(new Error('每日更新开关无效'),{status:400});next.dailyEnabled=input.dailyEnabled;}
 for(const [key,[min,max,label]] of Object.entries(ranges))if(input[key]!==undefined){if(!Number.isInteger(input[key])||input[key]<min||input[key]>max)throw Object.assign(new Error(`${label}应为 ${min}–${max} 的整数`),{status:400});next[key]=input[key];}
 return Object.assign(current,next);
}
// The hourly cloud clock remains fixed; this persisted gate selects which ticks
// actually check the Agents. A manual wake bypasses the clock gate.
export function claimAgentCheck(store,at=Date.now()){
 if(!store.agentSettings.enabled||!store.agents.some(a=>a.id!=='engineering'&&a.enabled))return false;
 const last=Date.parse(store.agentSchedule?.lastCheckAt||'');
 const interval=(store.agentSettings.checkIntervalHours||1)*3600000;
 if(Number.isFinite(last)&&at-last<interval)return false;
 store.agentSchedule={lastCheckAt:new Date(at).toISOString()};return true;
}
