import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const MAX_BODY_BYTES = 20_000;
const responseHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function runtimeConfig(env = process.env) {
  const port = Number(env.PORT || 10000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  const configuredOrigin = env.PUBLIC_ORIGIN || env.RENDER_EXTERNAL_URL;
  if (env.RENDER === 'true' && !configuredOrigin) throw new Error('Render requires RENDER_EXTERNAL_URL or PUBLIC_ORIGIN.');
  let url;
  try { url = new URL(configuredOrigin || `http://127.0.0.1:${port}`); }
  catch { throw new Error('PUBLIC_ORIGIN must be a valid HTTP or HTTPS origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_ORIGIN must contain only an HTTP or HTTPS origin.');
  }
  if (env.RENDER === 'true' && url.protocol !== 'https:') throw new Error('The Render public origin must use HTTPS.');
  return { host: '0.0.0.0', port, origin: url.origin };
}

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Reject declared sizes immediately and stop retaining chunks at the byte limit.
// Keep the incoming stream drainable so a 413 response can reach the client.
function readBody(req) {
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    req.resume();
    return Promise.reject(new RequestError(413, 'Request too large.'));
  }
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let oversized = false;
    req.on('data', chunk => {
      if (oversized) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        oversized = true;
        chunks.length = 0;
        reject(new RequestError(413, 'Request too large.'));
      } else chunks.push(chunk);
    });
    req.once('end', () => { if (!oversized) resolveBody(Buffer.concat(chunks, size)); });
    req.once('error', () => reject(new RequestError(400, 'Request interrupted.')));
    req.once('aborted', () => reject(new RequestError(400, 'Request interrupted.')));
  });
}

export function createStockLensServer({ origin, fetchHandler }) {
  if (typeof fetchHandler !== 'function') throw new Error('A worker fetch handler is required.');
  return http.createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, async (req, res) => {
    // Clients may disconnect while an early rejection is being returned.
    req.on('error', () => {});
    try {
      if (!req.url?.startsWith('/')) throw new RequestError(400, 'Invalid request target.');
      // Render terminates HTTPS at its edge. Use trusted deployment configuration,
      // never Host / X-Forwarded-* headers, for the worker's same-origin check.
      const url = new URL(origin + req.url);
      if (url.pathname === '/healthz' && ['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(200, responseHeaders);
        res.end(req.method === 'HEAD' ? undefined : '{"status":"ok"}');
        return;
      }
      const body = await readBody(req);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const request = new Request(url, {
        method: req.method,
        headers,
        ...(['GET', 'HEAD'].includes(req.method) ? {} : { body }),
      });
      const result = await fetchHandler(request, {});
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof RequestError ? error.status : 500;
      res.writeHead(status, { ...responseHeaders, Connection: 'close' });
      res.end(JSON.stringify({ error: status === 500 ? 'Server error.' : error.message }));
    }
  });
}

async function main() {
  const config = runtimeConfig();
  const { default: worker } = await import('../worker/index.js');
  const server = createStockLensServer({ origin: config.origin, fetchHandler: worker.fetch.bind(worker) });
  server.on('error', () => {
    console.error('StockLens could not start. Check PORT and runtime configuration.');
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => console.log(`StockLens listening on ${config.host}:${config.port}`));
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 25_000);
    deadline.unref();
    server.close(() => { clearTimeout(deadline); });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('StockLens startup failed. Run npm run build:render and check PORT / PUBLIC_ORIGIN.');
    process.exitCode = 1;
  });
}
