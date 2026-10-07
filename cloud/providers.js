import {env} from 'cloudflare:workers';
import {createResponsesProvider} from '../lib/openai-provider.js';
export let configuredModel='';
export let analysisProvider='';
function provider(){
 const active=createResponsesProvider({env,provider:env.ANALYSIS_PROVIDER||'openai'});
 configuredModel=active.model;analysisProvider=active.provider;return active;
}
export const runtimeStatus=()=>provider().runtimeStatus();
export const runStructured=(...args)=>provider().runStructured(...args);
