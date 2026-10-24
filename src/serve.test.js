import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createStockLensServer, runtimeConfig } from '../scripts/serve.mjs';

const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
const prefix = `const ASSETS={'/index.html':{type:'text/html',body:'<main>StockLens</main>'}}; async function brokerAction(body){return {action:body.action}};`;
const worker = (await import('data:text/javascript;base64,' + Buffer.from(prefix + source).toString('base64'))).default;
async function start(t, handler = worker.fetch) {
  const server = createStockLensServer({ origin: 'https://stocklens.onrender.com', fetchHandler: handler });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('Render runtime uses all interfaces, supplied port, and trusted HTTPS origin', () => {
  assert.deepEqual(runtimeConfig({ PORT: '12345', RENDER: 'true', RENDER_EXTERNAL_URL: 'https://stocklens.onrender.com' }), {
    host: '0.0.0.0', port: 12345, origin: 'https://stocklens.onrender.com',
  });
  assert.equal(runtimeConfig({ PUBLIC_ORIGIN: 'https://research.example.com/', RENDER_EXTERNAL_URL: 'https://other.onrender.com' }).origin, 'https://research.example.com');
  for (const env of [{PORT:'0'}, {PORT:'nan'}, {RENDER:'true'}, {PUBLIC_ORIGIN:'https://user:secret@example.com'}, {PUBLIC_ORIGIN:'https://example.com/path'}, {RENDER:'true', PUBLIC_ORIGIN:'http://example.com'}]) {
    assert.throws(() => runtimeConfig(env));
  }
});

test('health endpoint and dashboard work over the production HTTP adapter', async t => {
  const url = await start(t);
  const health = await fetch(url + '/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.match(await (await fetch(url + '/')).text(), /StockLens/);
  assert.equal(await (await fetch(url + '/', { method: 'HEAD' })).text(), '');
});

test('HTTPS browser requests pass origin checks behind Render, spoofed forwarding headers do not', async t => {
  const url = await start(t);
  for (const [origin, expected] of [['https://stocklens.onrender.com',200],['https://attacker.example',403]]) {
    const res = await fetch(url + '/api/broker', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-Proto': 'https' },
      body: '{"action":"holdings"}',
    });
    assert.equal(res.status, expected);
  }
});

test('declared and chunked oversized bodies are rejected before reaching the worker', { timeout: 5_000 }, async t => {
  let calls = 0;
  const url = await start(t, async () => { calls++; return new Response('unexpected'); });
  const declared = await fetch(url + '/api/broker', { method: 'POST', body: 'a'.repeat(20_001) });
  assert.equal(declared.status, 413);
  const headersOnlyStatus = await new Promise((resolve, reject) => {
    const req = http.request(url + '/api/broker', { method: 'POST', headers: { 'Content-Length': '999999999' } }, res => {
      res.resume();
      res.on('end', () => { resolve(res.statusCode); req.destroy(); });
    });
    req.on('error', reject);
    req.flushHeaders(); // No body is sent: a declared oversize must be rejected now.
  });
  assert.equal(headersOnlyStatus, 413);
  const chunkedStatus = await new Promise((resolve, reject) => {
    const req = http.request(url + '/api/broker', { method: 'POST' }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write('a'.repeat(10_000));
    req.write('b'.repeat(10_001));
    req.end();
  });
  assert.equal(chunkedStatus, 413);
  assert.equal(calls, 0);
});

test('body limit counts UTF-8 bytes and allows a request exactly at the boundary', async t => {
  let calls = 0;
  const url = await start(t, async request => { calls++; return new Response(String((await request.arrayBuffer()).byteLength)); });
  const accepted = await fetch(url + '/api/broker', { method: 'POST', body: 'x'.repeat(20_000) });
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), '20000');
  const rejected = await fetch(url + '/api/broker', { method: 'POST', body: '₹'.repeat(7_000) });
  assert.equal(rejected.status, 413);
  assert.equal(calls, 1);
});

test('adapter errors are sanitized without leaking broker credentials', async t => {
  const url = await start(t, async () => { throw new Error('sensitive-token'); });
  const res = await fetch(url + '/');
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'Server error.' });
});
