import {WorkerEntrypoint} from 'cloudflare:workers';
import {collectSource,extractArticle} from '../lib/collect.js';
import {syncBlog,syncRepositories,getRepositoryEvidence} from '../lib/profile.js';
import {analyzeArticles,analyzeBlogs,analyzeRepository} from '../lib/analyzer.js';
import {fetchText} from './network.js';
import {discoveryMetadata} from './job-runner.js';

// Private RPC entrypoint: each invocation has its own outbound request budget.
// Raw external text stays inside this invocation, never in Workflow checkpoints.
export class IntelligenceTasks extends WorkerEntrypoint {
  async discover(source,options){return discoveryMetadata(await collectSource(source,{...options,expand:false}));}
  async syncBlog(){return syncBlog();}
  async syncRepositories(){return syncRepositories();}
  async getRepositoryEvidence(repo){return getRepositoryEvidence(repo);}
  async analyzeRepository(repo,evidence){return analyzeRepository(repo,evidence);}
  async analyzeBlogs(items){return analyzeBlogs(items);}
  async analyzeArticles(items,context){
    const enriched=[];
    const feeds=new Map();
    for(const item of items){
      const article={...item};
      if(!article.summary){
        const source=context.sources.find(s=>s.id===article.sourceId);
        if(source){
          if(!feeds.has(source.id))feeds.set(source.id,await collectSource(source,{limit:context.settings.sourceArticleLimit,sinceDays:context.settings.collectionSinceDays,expand:false}));
          article.excerpt=feeds.get(source.id).articles.find(a=>a.url.replace(/\/$/,'')===article.url)?.excerpt||'';
        }
        article.readingScope='feed_summary';
        try{const extracted=extractArticle(await fetchText(article.url,{timeoutMs:15000}));if(extracted.excerpt.length){article.excerpt=extracted.excerpt;article.readingScope='original_excerpt';}}catch(error){article.readingError=String(error.message||error).slice(0,300);}
      }else{
        article.readingScope='saved_summary';
      }
      enriched.push(article);
    }
    const analyses=await analyzeArticles(enriched,context);
    return analyses.map(analysis=>({...analysis,readingScope:enriched.find(item=>item.id===analysis.id)?.readingScope}));
  }
}
