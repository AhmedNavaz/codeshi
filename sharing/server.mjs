import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SharingStore, MAX_BODY_BYTES, fail } from './store.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
function json(res, code, value) {
  const source = JSON.stringify(value);
  if (Buffer.byteLength(source) > MAX_BODY_BYTES) throw fail('The response exceeds the sharing limit.', 413);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(source);
}
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail('Send JSON content.', 415);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw fail('The request exceeds 2 MiB.', 413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('Invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Send a JSON object.');
  return value;
}
const bearer = req => /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '')?.[1];

export function createSharingServer({ dataDir = path.join(root, '.data'), createKey = process.env.SHARING_CREATE_KEY,
  requireHttps = process.env.REQUIRE_HTTPS === 'true', ...storeOptions } = {}) {
  const store = new SharingStore({ dataDir, ...storeOptions });
  const attempts = new Map();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (requireHttps && !req.socket.encrypted && req.headers['x-forwarded-proto'] !== 'https') throw fail('HTTPS is required.', 403);
      const url = new URL(req.url, 'http://sharing.invalid');
      const route = url.pathname;
      if (req.method === 'OPTIONS') throw fail('Cross-origin access is unavailable.', 403);
      const asset = assets[route] || (/^\/r\/[a-f0-9-]{36}$/.test(route) ? assets['/'] : null);
      if (req.method === 'GET' && asset) {
        res.writeHead(200, { 'Content-Type': asset[1] });
        return res.end(fs.readFileSync(path.join(root, 'public', asset[0])));
      }
      if (req.method === 'GET' && route === '/health') return json(res, 200, { ok: true });
      if (req.method === 'GET' && route === '/format.mjs') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(root, '../src/collaboration-format.mjs')));
      }
      if (req.method === 'POST' && route === '/api/requests') {
        if (createKey && req.headers['x-sharing-create-key'] !== createKey) throw fail('Request creation is not authorized.', 403);
        const key = req.socket.remoteAddress;
        const now = Date.now();
        for (const [address, item] of attempts) if (item.until <= now) attempts.delete(address);
        const quota = attempts.get(key) || { count: 0, until: now + 60000 };
        if (++quota.count > 30) throw fail('Too many uploads. Retry in a minute.', 429);
        attempts.set(key, quota);
        const result = store.create(await body(req));
        return json(res, result.created ? 201 : 200, result.record);
      }
      const match = route.match(/^\/api\/requests\/([a-f0-9-]{36})(?:\/(package|source|solutions|revoke))?$/);
      if (!match) throw fail('Not found.', 404);
      const [ , id, action ] = match;
      if (req.method === 'GET' && !action) {
        const record = store.authorize(id, 'view', bearer(req));
        return json(res, 200, { ...store.summary(record), package: record.package });
      }
      if (req.method === 'GET' && action === 'package') {
        const record = store.authorize(id, 'view', bearer(req));
        res.setHeader('Content-Disposition', 'attachment; filename="ai-relay-request.json"');
        return json(res, 200, record.package);
      }
      if (req.method === 'GET' && action === 'source') {
        const record = store.authorize(id, 'view', bearer(req));
        const file = record.package.files.find(item => item.path === url.searchParams.get('path'));
        if (!file) throw fail('Approved source not found.', 404);
        // Source names are lookup keys inside approved JSON, never filesystem paths.
        // A binary file (#25) is sent as its bytes, still only as a download.
        if (file.encoding === 'base64') {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="approved-source.bin"' });
          return res.end(Buffer.from(file.content, 'base64'));
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="approved-source.txt"' });
        return res.end(file.content);
      }
      if (req.method === 'POST' && action === 'solutions') {
        const record = store.authorize(id, 'submit', bearer(req));
        const result = store.submit(record, await body(req));
        return json(res, result.created ? 201 : 200, { id: result.solution.id, handoffId: record.handoffId, received: true });
      }
      if (req.method === 'GET' && action === 'solutions') {
        const record = store.authorize(id, 'owner', bearer(req));
        return json(res, 200, { ...store.summary(record), solutions: record.solutions });
      }
      if (req.method === 'POST' && action === 'revoke') {
        const record = store.authorize(id, 'owner', bearer(req), { allowGone: true });
        await body(req);
        return json(res, 200, store.revoke(record));
      }
      throw fail('Not found.', 404);
    } catch (error) {
      if (res.headersSent) return res.end();
      // No request URLs, headers, payloads or capability tokens are logged.
      return json(res, error.status || 400, { error: error.status ? error.message : 'The package or solution could not be validated.' });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return { server, store, close: () => new Promise(resolve => server.close(resolve)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4319);
  const host = process.env.HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid sharing port.');
  const app = createSharingServer({ dataDir: process.env.SHARING_DATA_DIR || path.join(root, '.data') });
  app.server.listen(port, host, () => console.log(`Private sharing service listening on ${host}:${port}.`));
  const close = () => app.close().catch(() => { process.exitCode = 1; });
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
