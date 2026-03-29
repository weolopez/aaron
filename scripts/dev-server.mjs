/**
 * dev-server.mjs — Local dev server with Anthropic API proxy
 *
 * Serves static files and proxies /v1/* to api.anthropic.com server-side,
 * bypassing browser CORS restrictions on direct API calls.
 *
 * Usage: node scripts/dev-server.mjs [port]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = parseInt(process.argv[2] || process.env.PORT || '8080', 10);
const ROOT = join(fileURLToPath(import.meta.url), '../..');
const ANTHROPIC_API = 'https://api.anthropic.com';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.txt':  'text/plain; charset=utf-8',
};

const PROXY_HEADERS = [
  'x-api-key',
  'anthropic-version',
  'anthropic-dangerous-allow-browser',
  'content-type',
];

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // ── Anthropic API proxy ──────────────────────────────
  if (url.pathname.startsWith('/v1/')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': PROXY_HEADERS.join(', '),
      });
      res.end();
      return;
    }

    try {
      const body = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
      });

      const forwardHeaders = {};
      for (const h of PROXY_HEADERS) {
        if (req.headers[h]) forwardHeaders[h] = req.headers[h];
      }

      const upstream = await fetch(`${ANTHROPIC_API}${url.pathname}${url.search}`, {
        method: req.method,
        headers: forwardHeaders,
        body: body.length ? body : undefined,
      });

      const data = await upstream.arrayBuffer();
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(Buffer.from(data));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Static file server ───────────────────────────────
  try {
    const filePath = join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
    await stat(filePath);
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

}).listen(PORT, '127.0.0.1', () => {
  console.log(`Aaron dev server: http://127.0.0.1:${PORT}/agent-harness.html`);
  console.log(`Anthropic API proxy: http://127.0.0.1:${PORT}/v1/messages -> ${ANTHROPIC_API}/v1/messages`);
});
