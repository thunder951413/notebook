// Notebook Server — a zero-dependency Linux web server for the notebook app.
// Usage: node server/server.js  (env: PORT, HOST, DATA_DIR)
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { createApi } from './api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const WEB_DIR = path.join(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

const store = new Store(DATA_DIR);
try {await store.init();}catch(error){
  await store.diagnostics.record('app.start.failed',{level:'error',error});
  await store.diagnostics.close();console.error('Notebook startup failed; see DATA_DIR/diagnostics/events.jsonl');process.exit(1);
}
const api = createApi(store);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const pathname = decodeURIComponent(url.pathname);
    const urlParams = Object.fromEntries(url.searchParams.entries());

    // API
    if (pathname.startsWith('/api/')) {
      const handled = await api.handle(req, res, pathname, urlParams);
      if (handled) return;
    }

    // Static web assets (no path traversal)
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const filePath = path.normalize(path.join(WEB_DIR, rel));
    if (!filePath.startsWith(WEB_DIR + path.sep) && filePath !== path.join(WEB_DIR, 'index.html')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    let data;
    try {
      data = await fs.promises.readFile(filePath);
    } catch {
      // SPA fallback
      try { data = await fs.promises.readFile(path.join(WEB_DIR, 'index.html')); }
      catch { res.writeHead(404).end('not found'); return; }
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ['.html', '.js', '.mjs', '.css'].includes(ext) ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  } catch (err) {
    void store.diagnostics.record('http.failed',{level:'error',error:err});
    if (!res.headersSent) res.writeHead(500);
    res.end('internal error');
  }
});

server.listen(PORT, HOST, () => {
  console.log('Notebook server listening on http://' + HOST + ':' + PORT);
  console.log('  data dir: ' + DATA_DIR);
  void store.diagnostics.record('app.start',{count:store.s.pages.length});
});

let stopping=false;
async function shutdown() {
  if(stopping)return;stopping=true;
  const watchdog=setTimeout(()=>{process.exit(1);},5000);watchdog.unref();
  server.close(async()=>{
    try {await store.flush();await store.diagnostics.record('app.stop');await store.diagnostics.close();process.exit(0);}
    catch(error){await store.diagnostics.record('app.stop.failed',{level:'error',error});await store.diagnostics.close();process.exit(1);}
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
async function fatal(error) {
  if(stopping)return;stopping=true;
  const watchdog=setTimeout(()=>process.exit(1),1000);watchdog.unref();
  await store.diagnostics.record('app.fatal',{level:'error',error});await store.diagnostics.close();process.exit(1);
}
process.on('uncaughtException',fatal);
process.on('unhandledRejection',fatal);
