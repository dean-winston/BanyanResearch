import {env} from 'cloudflare:workers';
import {createCloudStore} from './store.js';
// Deployment validation does not expose live bindings at module evaluation.
// Initialize only within a request, scheduled invocation or workflow step.
let store;
const current=()=>store||=createCloudStore(env);
export const readStore=()=>current().readStore();
export const updateStore=change=>current().updateStore(change);
export const initializeStore=()=>current().initializeStore();
