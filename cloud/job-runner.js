import {createJobRunner} from '../lib/jobs.js';

// Only permitted metadata and generated analysis cross durable step boundaries.
export function discoveryMetadata(result) {
  return {status:result.status,feedUrl:result.feedUrl||'',error:result.error||'',articles:result.articles.map(({url,title,publishedAt,topics,sourceId,sourceName})=>({url,title,publishedAt,topics,sourceId,sourceName}))};
}
export function createCloudJobRunner(step,jobId,tasks) {
  const run=(name,fn)=>step.do(`${jobId}-${name}`,{retries:{limit:0,delay:'1 second',backoff:'constant'},timeout:'10 minutes'},fn);
  let blogs=0,repos=0,articles=0;
  return createJobRunner({
    collectionConcurrency:1,
    collectSource:(source,options)=>run(`discover-${source.id}`,()=>tasks.discover(source,options)),
    syncBlog:()=>run('sync-blog',()=>tasks.syncBlog()),
    syncRepositories:()=>run('sync-repositories',()=>tasks.syncRepositories()),
    analyzeBlogs:items=>run(`blog-analysis-${blogs++}`,()=>tasks.analyzeBlogs(items)),
    getRepositoryEvidence:repo=>run(`repository-evidence-${repo.id}`,()=>tasks.getRepositoryEvidence(repo)),
    analyzeRepository:(repo,evidence)=>run(`repository-analysis-${repos++}`,()=>tasks.analyzeRepository(repo,evidence)),
    analyzeArticles:(items,context)=>run(`article-analysis-${articles++}`,()=>tasks.analyzeArticles(items,context))
  });
}
