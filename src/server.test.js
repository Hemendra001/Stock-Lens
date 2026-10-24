import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./server.js',import.meta.url),'utf8');
const prefix=`const ASSETS={'/index.html':{type:'text/html',body:'<main>StockLens</main>'}}; async function brokerAction(body){return {action:body.action}};`;
const worker=(await import('data:text/javascript;base64,'+Buffer.from(prefix+source).toString('base64'))).default;
test('server serves HTML with restrictive browser resource policy',async()=>{
 const res=await worker.fetch(new Request('https://stocklens.test/'));
 assert.equal(res.status,200);assert.match(res.headers.get('content-security-policy'),/connect-src 'self'/);assert.equal(res.headers.get('cache-control'),'no-store');
});
test('broker route blocks cross-origin requests before upstream',async()=>{
 const res=await worker.fetch(new Request('https://stocklens.test/api/broker',{method:'POST',headers:{Origin:'https://other.test','Content-Type':'application/json'},body:'{}'}));
 assert.equal(res.status,403);
});
test('broker route requires POST with JSON',async()=>{
 assert.equal((await worker.fetch(new Request('https://stocklens.test/api/broker'))).status,405);
 assert.equal((await worker.fetch(new Request('https://stocklens.test/api/broker',{method:'POST',body:'{}'}))).status,415);
});
test('malformed and oversized JSON is rejected',async()=>{
 for(const [body,status] of [['{',400],[' '.repeat(20001),413]]) assert.equal((await worker.fetch(new Request('https://stocklens.test/api/broker',{method:'POST',headers:{'Content-Type':'application/json'},body}))).status,status);
});
test('same-origin JSON receives non-cacheable normalized response',async()=>{
 const res=await worker.fetch(new Request('https://stocklens.test/api/broker',{method:'POST',headers:{Origin:'https://stocklens.test','Content-Type':'application/json'},body:JSON.stringify({action:'holdings'})}));
 assert.equal(res.status,200);assert.deepEqual(await res.json(),{action:'holdings'});assert.equal(res.headers.get('cache-control'),'no-store');
});
