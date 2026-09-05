import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Store } from '../server/store.js';
import { createApi } from '../server/api.js';

export async function startServerFixture(t, options = {}) {
  const dataDir = options.dataDir || await fs.mkdtemp(path.join(os.tmpdir(), 'notebook-server-test-'));
  const ownsDir = !options.dataDir;
  const store = new Store(dataDir);
  await store.init();
  const api = createApi(store);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    await api.handle(req, res, decodeURIComponent(url.pathname), Object.fromEntries(url.searchParams));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await store.flush().catch(() => {});
    await new Promise(resolve => server.close(resolve));
    await store.diagnostics.close();
    if (ownsDir) await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { store, server, baseUrl, dataDir, client: createClient(baseUrl) };
}

export function createClient(baseUrl) {
  let cookie = '';
  return {
    clearCookie() { cookie = ''; },
    get cookie() { return cookie; },
    set cookie(value) { cookie = value; },
    async request(pathname, options = {}) {
      const headers = new Headers(options.headers || {});
      if (cookie) headers.set('cookie', cookie);
      let body = options.body;
      if (options.json !== undefined) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(options.json);
      }
      const response = await fetch(baseUrl + pathname, { ...options, headers, body });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';', 1)[0];
      return response;
    },
    async json(pathname, options = {}) {
      const response = await this.request(pathname, options);
      const value = await response.json();
      return { response, value };
    },
  };
}
