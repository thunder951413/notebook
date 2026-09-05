import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { buildZip, crc32, readZip } from '../server/util.js';
import { Store } from '../server/store.js';
import { createClient, startServerFixture } from './server-fixture.mjs';

test('ZIP export is structurally valid, UTF-8 safe, and imports DEFLATE data descriptors', async t => {
  const { client } = await startServerFixture(t);
  const notebook = (await client.json('/api/notebooks', { method: 'POST', json: { name: '资料' } })).value;
  const page = (await client.json('/api/pages', { method: 'POST', json: {
    notebookId: notebook.id, title: '参考笔记', markdown: '# 内容\n你好',
  } })).value;
  await client.json('/api/pages', { method: 'POST', json: {
    notebookId: notebook.id, title: '参考笔记', markdown: '同名页面也必须保留',
  } });

  const single = await client.request(`/api/export/page/${page.id}`);
  assert.equal(single.status, 200);
  assert.match(single.headers.get('content-disposition'), /filename\*=UTF-8''%E5%8F%82%E8%80%83%E7%AC%94%E8%AE%B0\.md/);

  const all = await client.request('/api/export/all');
  assert.equal(all.status, 200);
  const exported = readZip(Buffer.from(await all.arrayBuffer()));
  assert.equal(exported.get('资料/参考笔记.md').toString(), '# 内容\n你好');
  const duplicateBodies = [...exported.entries()].filter(([name]) => name.startsWith('资料/参考笔记')).map(([, data]) => data.toString());
  assert.deepEqual(duplicateBodies.sort(), ['# 内容\n你好', '同名页面也必须保留'].sort());

  const deflated = buildDeflatedDescriptorZip('目录/压缩.md', Buffer.from('deflated text'));
  const imported = new FormData();
  imported.set('notebookId', notebook.id);
  imported.set('file', new Blob([deflated], { type: 'application/zip' }), 'archive.zip');
  const result = await client.json('/api/import', { method: 'POST', body: imported });
  assert.equal(result.response.status, 200);
  assert.equal(result.value.created, 1);
});

test('locks protect password changes, notebook/section/page adjuncts, and survive multiple unlock tokens', async t => {
  const { client, store, dataDir, baseUrl } = await startServerFixture(t);
  const nb1 = (await client.json('/api/notebooks', { method: 'POST', json: { name: 'One' } })).value;
  const nb2 = (await client.json('/api/notebooks', { method: 'POST', json: { name: 'Two' } })).value;
  const publicNb = (await client.json('/api/notebooks', { method: 'POST', json: { name: 'Public' } })).value;
  const section = (await client.json('/api/sections', { method: 'POST', json: { notebookId: nb1.id, name: 'Secret' } })).value;
  const page1 = (await client.json('/api/pages', { method: 'POST', json: { notebookId: nb1.id, sectionId: section.id, title: 'A', markdown: 'private-leak-marker' } })).value;
  const page2 = (await client.json('/api/pages', { method: 'POST', json: { notebookId: nb2.id, title: 'B', markdown: 'b' } })).value;
  const publicPage = (await client.json('/api/pages', { method: 'POST', json: { notebookId: publicNb.id, title: 'Public', markdown: 'public' } })).value;
  await client.json(`/api/notebooks/${nb1.id}/lock`, { method: 'POST', json: { password: 'one-pass' } });
  await client.json(`/api/notebooks/${nb2.id}/lock`, { method: 'POST', json: { password: 'two-pass' } });
  await client.json(`/api/notebooks/${nb1.id}/unlock`, { method: 'POST', json: { password: 'one-pass' } });
  await client.json(`/api/notebooks/${nb2.id}/unlock`, { method: 'POST', json: { password: 'two-pass' } });
  assert.equal((await client.request(`/api/pages/${page1.id}`)).status, 200);
  assert.equal((await client.request(`/api/pages/${page2.id}`)).status, 200);
  const unlockedExport = readZip(Buffer.from(await (await client.request('/api/export/all')).arrayBuffer()));
  assert.ok([...unlockedExport.values()].some(data => data.toString() === 'private-leak-marker'));

  const upload = new FormData();
  upload.set('pageId', page1.id);
  upload.set('file', new Blob(['private bytes'], { type: 'text/plain' }), '秘密.txt');
  const asset = (await client.json('/api/upload', { method: 'POST', body: upload })).value;
  await store.flush();
  const reopened = new Store(dataDir);
  await reopened.init();
  assert.equal(reopened.s.assets.length, 1);
  const restarted = await startServerFixture(t, { dataDir });
  assert.equal((await restarted.client.request(`/api/assets/${asset.assetId}/data`)).status, 403);
  restarted.client.cookie = client.cookie;
  assert.equal((await restarted.client.request(`/api/assets/${asset.assetId}/data`)).status, 200);

  const outsider = createClient(baseUrl);
  const privateSearch = await outsider.json('/api/search?q=private-leak-marker&includeLocked=1');
  assert.equal(privateSearch.response.status, 200);
  assert.deepEqual(privateSearch.value.items, []);
  for (const [url, method, json] of [
    [`/api/notebooks/${nb1.id}/lock`, 'POST', { password: 'stolen-pass' }],
    [`/api/notebooks/${nb1.id}`, 'PATCH', { name: 'stolen' }],
    [`/api/notebooks/${nb1.id}`, 'DELETE', undefined],
    [`/api/sections/${section.id}`, 'DELETE', undefined],
    [`/api/pages/${page1.id}/revisions`, 'GET', undefined],
    [`/api/pages/${page1.id}/position`, 'GET', undefined],
    [`/api/pages/${page1.id}/position`, 'PUT', { anchorOffset: 1 }],
  ]) {
    const response = await outsider.request(url, { method, json });
    assert.equal(response.status, 403, `${method} ${url}`);
  }
  const traversal = await outsider.request(`/api/pages/${page1.id}/revisions/%252e%252e%252f`);
  assert.equal(traversal.status, 400);
  const moveDenied = await outsider.request(`/api/pages/${publicPage.id}`, {
    method: 'PUT', json: { notebookId: nb1.id, sectionId: null },
  });
  assert.equal(moveDenied.status, 403);
  const deniedAsset = await outsider.request(`/api/assets/${asset.assetId}/data`);
  assert.equal(deniedAsset.status, 403);
  assert.equal((await outsider.request(`/api/assets/${asset.assetId}`)).status, 403);
  const allowedAsset = await client.request(`/api/assets/${asset.assetId}/data`);
  assert.equal(allowedAsset.status, 200);
  assert.equal(allowedAsset.headers.get('cache-control'), 'private, no-store');
});

test('page saves are serialized, detect conflicts, keep explicit titles, and preserve timestamps for no-ops', async t => {
  const { client, dataDir, store } = await startServerFixture(t);
  const notebook = (await client.json('/api/notebooks', { method: 'POST', json: { name: 'Work' } })).value;
  const created = (await client.json('/api/pages', { method: 'POST', json: { notebookId: notebook.id, title: 'Chosen', markdown: 'start' } })).value;

  const noOp = await client.json(`/api/pages/${created.id}`, { method: 'PUT', json: {
    title: 'Chosen', markdown: 'start', expectedUpdatedAt: created.updatedAt,
  } });
  assert.equal(noOp.value.updatedAt, created.updatedAt);

  const changed = await client.json(`/api/pages/${created.id}`, { method: 'PUT', json: {
    title: 'Chosen', markdown: '# Derived must not win\nfirst', expectedUpdatedAt: created.updatedAt,
  } });
  assert.equal(changed.response.status, 200);
  assert.equal(changed.value.title, 'Chosen');
  assert.ok(changed.value.updatedAt > created.updatedAt);

  const stale = await client.json(`/api/pages/${created.id}`, { method: 'PUT', json: {
    markdown: 'stale', expectedUpdatedAt: created.updatedAt,
  } });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.value.code, 'conflict');
  assert.equal(stale.value.currentUpdatedAt, changed.value.updatedAt);

  const originalWriteBody = store.writeBody.bind(store);
  let failOnce = true;
  store.writeBody = async (...args) => {
    if (failOnce) { failOnce = false; throw new Error('injected body write failure'); }
    return originalWriteBody(...args);
  };
  await assert.rejects(() => store.savePage(created.id, {
    markdown: 'must not stick', expectedUpdatedAt: changed.value.updatedAt,
  }, new Set()), /injected body write failure/);
  assert.equal(store.getPage(created.id, new Set()).updatedAt, changed.value.updatedAt);
  assert.equal(await store.readBody(created.id), '# Derived must not win\nfirst');
  store.writeBody = originalWriteBody;
  const retry = await client.json(`/api/pages/${created.id}`, { method: 'PUT', json: {
    markdown: 'retry succeeds', expectedUpdatedAt: changed.value.updatedAt,
  } });
  assert.equal(retry.response.status, 200);

  const expected = retry.value.updatedAt;
  const pair = await Promise.all(['left', 'right'].map(markdown => client.json(`/api/pages/${created.id}`, {
    method: 'PUT', json: { markdown, expectedUpdatedAt: expected },
  })));
  assert.deepEqual(pair.map(item => item.response.status).sort(), [200, 409]);
  const winner = pair.find(item => item.response.status === 200).value;
  const reopened = new Store(dataDir);
  await reopened.init();
  assert.equal(await reopened.readBody(created.id), winner.preview);
  assert.equal((await fs.readdir(path.join(dataDir, 'pages'))).some(name => name.includes('.tmp-')), false);
});

test('complete backup requires unlocked private notebooks and restores all linked data only into an empty workspace', async t => {
  const source = await startServerFixture(t);
  const nb = (await source.client.json('/api/notebooks', { method: 'POST', json: { name: 'Private' } })).value;
  const page = (await source.client.json('/api/pages', { method: 'POST', json: { notebookId: nb.id, title: '秘密', markdown: 'body' } })).value;
  const tag = (await source.client.json('/api/tags', { method: 'POST', json: { name: 'tag' } })).value;
  await source.client.json(`/api/pages/${page.id}/tags`, { method: 'PUT', json: { tagIds: [tag.id] } });
  const upload = new FormData();
  upload.set('pageId', page.id);
  upload.set('file', new Blob(['asset-body']), 'a.txt');
  const asset = (await source.client.json('/api/upload', { method: 'POST', body: upload })).value;
  await source.client.json(`/api/notebooks/${nb.id}/lock`, { method: 'POST', json: { password: 'backup-pass' } });
  const denied = await source.client.json('/api/backup');
  assert.equal(denied.response.status, 403);
  assert.equal(denied.value.code, 'locked');
  await source.client.json(`/api/notebooks/${nb.id}/unlock`, { method: 'POST', json: { password: 'backup-pass' } });
  const backupResponse = await source.client.request('/api/backup');
  assert.equal(backupResponse.status, 200);
  const backup = Buffer.from(await backupResponse.arrayBuffer());
  const manifest = JSON.parse(readZip(backup).get('manifest.json'));
  assert.equal(manifest.state.pages.length, 1);
  assert.equal(manifest.state.pageTags.length, 1);
  assert.equal(manifest.state.assets.length, 1);
  assert.ok(manifest.revisions.length >= 1);
  assert.deepEqual(manifest.state.lockSessions, []);

  const target = await startServerFixture(t);
  const invalidEntries = readZip(backup);
  const invalidCredentials = JSON.parse(invalidEntries.get('manifest.json'));
  invalidCredentials.state.notebooks[0].lockHash = 'invalid';
  invalidEntries.set('manifest.json', Buffer.from(JSON.stringify(invalidCredentials)));
  const invalidForm = new FormData();
  invalidForm.set('file', new Blob([buildZip([...invalidEntries].map(([name, data]) => ({ name, data })))]), 'invalid.zip');
  const invalid = await target.client.json('/api/backup/restore', { method: 'POST', body: invalidForm });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.value.code, 'invalid_backup');

  const cyclicEntries = readZip(backup);
  const cyclicManifest = JSON.parse(cyclicEntries.get('manifest.json'));
  cyclicManifest.state.pages[0].parentPageId = cyclicManifest.state.pages[0].id;
  cyclicEntries.set('manifest.json', Buffer.from(JSON.stringify(cyclicManifest)));
  const cyclicForm = new FormData();
  cyclicForm.set('file', new Blob([buildZip([...cyclicEntries].map(([name, data]) => ({ name, data })))]), 'cyclic.zip');
  const cyclic = await target.client.json('/api/backup/restore', { method: 'POST', body: cyclicForm });
  assert.equal(cyclic.response.status, 400);
  assert.equal(cyclic.value.code, 'invalid_backup');

  const form = new FormData();
  form.set('file', new Blob([backup]), 'backup.zip');
  const restored = await target.client.json('/api/backup/restore', { method: 'POST', body: form });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.value.restored.pages, 1);
  assert.equal((await target.client.request(`/api/pages/${page.id}`)).status, 403);
  await target.client.json(`/api/notebooks/${nb.id}/unlock`, { method: 'POST', json: { password: 'backup-pass' } });
  assert.equal((await target.client.request(`/api/pages/${page.id}`)).status, 200);
  assert.equal((await target.client.request(`/api/assets/${asset.assetId}/data`)).status, 200);

  const again = new FormData();
  again.set('file', new Blob([backup]), 'backup.zip');
  const rejected = await target.client.json('/api/backup/restore', { method: 'POST', body: again });
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.value.code, 'workspace_not_empty');
});

test('logout revokes its server session and queued mutations re-check authentication', async t => {
  const { client, store, baseUrl } = await startServerFixture(t);
  store.updateSettings({ newPassword: 'server-password' });
  await store.flush();
  const login = await client.request('/api/login', { method: 'POST', json: { password: 'server-password' } });
  assert.equal(login.status, 200);
  const authenticatedCookie = client.cookie;
  assert.match(authenticatedCookie, /^nb_auth=/);

  const originalFlush = store.flush.bind(store);
  let releaseFlush;
  let enteredFlush;
  const flushGate = new Promise(resolve => { releaseFlush = resolve; });
  const entered = new Promise(resolve => { enteredFlush = resolve; });
  store.flush = async () => {
    enteredFlush();
    await flushGate;
    return originalFlush();
  };

  let first;
  let queued;
  const firstClient = createClient(baseUrl);
  firstClient.cookie = authenticatedCookie;
  const queuedClient = createClient(baseUrl);
  queuedClient.cookie = authenticatedCookie;
  try {
    first = firstClient.request('/api/notebooks', { method: 'POST', json: { name: 'first' } });
    let timeoutId;
    const event = await Promise.race([
      entered.then(() => 'entered'),
      first.then(response => `response:${response.status}`),
      new Promise(resolve => { timeoutId = setTimeout(() => resolve('timeout'), 2_000); }),
    ]);
    clearTimeout(timeoutId);
    assert.equal(event, 'entered');
    queued = queuedClient.request('/api/notebooks', { method: 'POST', json: { name: 'must be rejected' } });
    const logoutClient = createClient(baseUrl);
    logoutClient.cookie = authenticatedCookie;
    const logout = await logoutClient.request('/api/logout', { method: 'POST' });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    releaseFlush();
    assert.equal((await first).status, 200);
    assert.equal((await queued).status, 401);

    logoutClient.cookie = authenticatedCookie;
    assert.equal((await logoutClient.request('/api/state')).status, 401);
  } finally {
    releaseFlush();
    store.flush = originalFlush;
  }
});

test('corrupt indexes fail closed and recurring reminders project without mutating pages', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notebook-corrupt-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dataDir, 'pages'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'index.json'), '{broken');
  await assert.rejects(() => new Store(dataDir).init(), /corrupt; refusing to start/);
  await fs.writeFile(path.join(dataDir, 'index.json'), '{}');
  await assert.rejects(() => new Store(dataDir).init(), /invalid workspace metadata; refusing to start/);
  for (const invalidIndex of ['null', 'false', '0']) {
    await fs.writeFile(path.join(dataDir, 'index.json'), invalidIndex);
    await assert.rejects(() => new Store(dataDir).init(), /refusing to start/);
  }

  const failingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notebook-persist-test-'));
  t.after(() => fs.rm(failingDir, { recursive: true, force: true }));
  const failingStore = new Store(failingDir);
  await failingStore.init();
  failingStore.createNotebook({ name: 'must surface' });
  failingStore.indexPath = path.join(failingDir, 'missing-directory', 'index.json');
  await assert.rejects(() => failingStore.flush(), /ENOENT/);

  const fixture = await startServerFixture(t);
  const nb = fixture.store.createNotebook({ name: 'Reminders' });
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const page = await fixture.store.createPage({ notebookId: nb.id, title: 'Monthly', markdown: '' });
  page.reminderAt = old;
  page.recurrenceRule = 'monthly';
  const beforeUpdatedAt = page.updatedAt;
  const reminders = fixture.store.listReminders(new Set());
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].originalReminderAt, old);
  assert.match(reminders[0].recurrenceOccurrence, new RegExp(`^${page.id}:`));
  assert.equal(page.reminderAt, old);
  assert.equal(page.updatedAt, beforeUpdatedAt);
  assert.ok(new Date(reminders[0].reminderAt).getTime() >= Date.now() - 86_400_000);

  page.reminderAt = '2026-01-31T01:00:00.000Z';
  const boundaryNow = Date.parse('2026-03-01T00:30:00.000Z');
  const boundary = fixture.store.listReminders(new Set(), boundaryNow);
  assert.equal(boundary[0].reminderAt, '2026-02-28T01:00:00.000Z');
  const outsideWindow = fixture.store.listReminders(new Set(), Date.parse('2026-03-02T02:00:00.000Z'));
  assert.equal(outsideWindow[0].reminderAt, '2026-03-31T01:00:00.000Z');
});

function buildDeflatedDescriptorZip(name, data) {
  const nameBuf = Buffer.from(name);
  const compressed = zlib.deflateRawSync(data);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0808, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(nameBuf.length, 26);
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(compressed.length, 8);
  descriptor.writeUInt32LE(data.length, 12);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0808, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  const centralOffset = local.length + nameBuf.length + compressed.length + descriptor.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBuf.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBuf, compressed, descriptor, central, nameBuf, end]);
}

test('buildZip does not mix central records into local file data', () => {
  const zip = buildZip([{ name: 'a.txt', data: 'a' }, { name: 'b.txt', data: 'b' }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(36), 0x04034b50);
  assert.deepEqual([...readZip(zip).keys()], ['a.txt', 'b.txt']);
  const python = spawnSync('python3', ['-c', [
    'import io,sys,zipfile',
    'z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))',
    'assert z.read("a.txt") == b"a"',
    'assert z.read("b.txt") == b"b"',
  ].join(';')], { input: zip });
  assert.equal(python.status, 0, python.stderr.toString());
});
