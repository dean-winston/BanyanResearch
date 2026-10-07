import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const dataDirectory=process.env.DATA_DIR || path.join(root,'.data');
const dataFile=path.join(dataDirectory,'knowledge.json');
export {migrate,defaultSettings} from './state.js';
import {migrate} from './state.js';
export async function readStore(){try{return migrate(JSON.parse(await fs.readFile(dataFile,'utf8')));}catch(error){if(error.code==='ENOENT')return migrate();throw error;}}
let mutation=Promise.resolve();
export function updateStore(change){const operation=mutation.then(async()=>{const store=await readStore();const result=await change(store);await fs.mkdir(dataDirectory,{recursive:true});const tmp=`${dataFile}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(store,null,2));await fs.rename(tmp,dataFile);return result;});mutation=operation.catch(()=>{});return operation;}
export async function initializeStore(){await updateStore(store=>{for(const job of store.jobs)if(['running','queued'].includes(job.status)){job.status='interrupted';job.message='服务重启，任务已中断；可手动重新执行';job.finishedAt=new Date().toISOString();}});}
