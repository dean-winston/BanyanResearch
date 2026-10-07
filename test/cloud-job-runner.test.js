import test from 'node:test';
import assert from 'node:assert/strict';
import {discoveryMetadata} from '../cloud/job-runner.js';
import {collectSource} from '../lib/collect.js';
test('durable discovery excludes all external text except titles and permitted metadata',()=>{
 const value=discoveryMetadata({status:'success',articles:[{url:'https://example.com/article',title:'Title',excerpt:'SECRET BODY',content:'SECRET BODY',unknown:'SECRET BODY',sourceId:'a',topics:['ai']}]});
 assert.doesNotMatch(JSON.stringify(value),/SECRET|excerpt|content|unknown/);
 assert.equal(value.articles[0].title,'Title');
});
test('discovery at maximum source limit makes no article-page requests',async()=>{
 let requests=0;
 const source={id:'a',name:'Example',url:'https://example.com',feedUrl:'https://example.com/feed'};
 const result=await collectSource(source,{limit:20,expand:false,fetcher:async url=>{requests++;assert.equal(url,source.feedUrl);return '<rss><channel>'+Array.from({length:20},(_,i)=>`<item><title>Article ${i}</title><link>https://example.com/posts/${i}</link><description>short</description></item>`).join('')+'</channel></rss>';}});
 assert.equal(requests,1);assert.equal(result.articles.length,20);
});
