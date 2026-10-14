// REST API: all /api/* routes.
import { randomUUID } from 'node:crypto';
import { resourceRef } from './diagnostics.js';
import { uuid, readJson, buildZip, readZip, safeName, contentDisposition, stripMarkdown } from './util.js';

const LOCK_COOKIE = 'nb_lock';
const AUTH_COOKIE = 'nb_auth';
const MAX_UPLOAD = 256 * 1024 * 1024;

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function createApi(store) {
  const authSessions = new Map(); // token -> expiry ts
  let mutationQueue = Promise.resolve();

  function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function cookie(name, value, opts = {}) {
    let s = name + '=' + encodeURIComponent(value);
    if (Object.hasOwn(opts, 'maxAge')) s += '; Max-Age=' + opts.maxAge;
    if (opts.httpOnly) s += '; HttpOnly';
    if (opts.path) s += '; Path=' + opts.path;
    if (opts.sameSite) s += '; SameSite=' + opts.sameSite;
    return s;
  }

  /** Throws 401 when server login is required and session invalid. */
  function requireAuth(req) {
    if (!store.settings.requireLogin) return;
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[AUTH_COOKIE];
    const exp = authSessions.get(token);
    if (!exp || exp < Date.now()) {
      authSessions.delete(token);
      throw new HttpError(401, 'server login required', { code: 'login' });
    }
  }

  function unlockedIds(req) {
    const raw = parseCookies(req.headers.cookie)[LOCK_COOKIE] || '';
    const tokens = raw.split(',').filter(Boolean);
    return store.unlockedNotebookIds(tokens);
  }

  function currentLockTokens(req) {
    const raw = parseCookies(req.headers.cookie)[LOCK_COOKIE] || '';
    return raw.split(',').filter(Boolean);
  }

  function setLockCookie(res, tokens) {
    res.setHeader('Set-Cookie', cookie(LOCK_COOKIE, tokens.join(','), { maxAge: 12 * 3600, path: '/', sameSite: 'lax' }));
  }

  function requireNotebookAccess(req, notebookId) {
    const notebook = store.s.notebooks.find(item => item.id === notebookId);
    if (!notebook) throw new HttpError(404, 'notebook not found');
    if (notebook.locked && !unlockedIds(req).has(notebookId)) throw new HttpError(403, 'notebook is locked', { code: 'locked' });
    return notebook;
  }

  function requireSectionAccess(req, sectionId) {
    const section = store.s.sections.find(item => item.id === sectionId);
    if (!section) throw new HttpError(404, 'section not found');
    requireNotebookAccess(req, section.notebookId);
    return section;
  }

  function requirePageAccess(req, pageId) {
    const page = store.getPage(pageId, unlockedIds(req));
    if (!page) throw new HttpError(404, 'page not found');
    return page;
  }

  function validatePageDestination(req, page, patch) {
    const notebookId = patch.notebookId ?? page.notebookId;
    requireNotebookAccess(req, notebookId);
    const sectionId = patch.sectionId !== undefined ? patch.sectionId : page.sectionId;
    if (sectionId) {
      const section = requireSectionAccess(req, sectionId);
      if (section.notebookId !== notebookId) throw new HttpError(400, 'section does not belong to destination notebook');
    }
    const parentPageId = patch.parentPageId !== undefined ? patch.parentPageId : page.parentPageId;
    if (parentPageId) {
      const parent = requirePageAccess(req, parentPageId);
      if (parent.notebookId !== notebookId) throw new HttpError(400, 'parent page does not belong to destination notebook');
    }
  }

  // ---------- route table ----------

  const routes = [];
  function route(method, pattern, handler) {
    const parts = pattern.split('/').filter(Boolean);
    routes.push({ method, parts, handler, pattern });
  }

  function match(method, pathname) {
    const segs = pathname.split('/').filter(Boolean);
    for (const r of routes) {
      if (r.method !== method || segs.length !== r.parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const pat = r.parts[i];
        if (pat.startsWith(':')) {
          const value = decodeURIComponent(segs[i]);
          if (!/^[A-Za-z0-9-]{1,128}$/.test(value)) throw new HttpError(400, 'invalid resource identifier');
          params[pat.slice(1)] = value;
        }
        else if (pat !== segs[i]) { ok = false; break; }
      }
      if (ok) return { handler: r.handler, params, pattern:r.pattern };
    }
    return null;
  }

  /** Returns {body, status} to send, or null when the response was already ended. */
  async function dispatch(method, pathname, req, res) {
    const m = match(method, pathname);
    if (!m) throw new HttpError(404,'API route not found');
    req.diagnosticRoute=m.pattern;
    req.diagnosticResource=resourceRef(m.params.id);
    const isAuthRoute = method === 'POST' && (pathname === '/api/login' || pathname === '/api/logout');
    const execute = async () => {
      // A session may expire or be revoked while a mutation waits in the queue.
      if (!isAuthRoute) requireAuth(req);
      const result = await m.handler({ method, pathname, req, res, params: m.params });
      if (method !== 'GET' && !isAuthRoute) await store.flush();
      return result;
    };
    // Mutations and complete backup snapshots share one queue so the index and
    // referenced bodies/assets cannot be observed halfway through a write.
    if (!isAuthRoute && (method !== 'GET' || pathname === '/api/backup')) {
      const task = mutationQueue.catch(() => {}).then(execute);
      mutationQueue = task;
      return task;
    }
    return execute();
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on('data', c => {
        total += c.length;
        if (total > limit) { reject(new HttpError(413, 'upload too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function parseMultipart(buf, boundary) {
    const delim = Buffer.from('--' + boundary);
    const out = [];
    let pos = 0;
    while (true) {
      const start = buf.indexOf(delim, pos);
      if (start < 0) break;
      const afterBoundary = start + delim.length;
      // boundary line ends at CRLF; final delimiter is followed by '--'
      if (buf[afterBoundary] === 45 && buf[afterBoundary + 1] === 45) break; // '--'
      const headerStart = afterBoundary + 2; // skip CRLF
      const blank = buf.indexOf(Buffer.from('\r\n\r\n'), headerStart);
      if (blank < 0) break;
      const headerBlock = buf.subarray(headerStart, blank).toString('utf8');
      const nameM = /name="([^"]*)"/.exec(headerBlock);
      const fnM = /filename="([^"]*)"/.exec(headerBlock);
      const ctM = /content-type:\s*([^\r\n]+)/i.exec(headerBlock);
      const dataStart = blank + 4;
      const nextDelim = buf.indexOf(Buffer.from('\r\n--' + boundary), dataStart);
      if (nextDelim < 0) break;
      const data = Buffer.from(buf.subarray(dataStart, nextDelim));
      out.push({
        name: nameM ? nameM[1] : '',
        filename: fnM ? fnM[1] : null,
        contentType: ctM ? ctM[1].trim() : 'application/octet-stream',
        data,
        text: data.toString('utf8'),
      });
      pos = nextDelim + 2;
    }
    return out;
  }

  function field(fields, name) {
    const f = fields.find(x => x.name === name);
    return f ? f.text : undefined;
  }

  function num(v) { return v !== undefined && v !== '' ? Number(v) : undefined; }

  // ================= auth & settings =================

  route('POST', '/api/login', async ({ req, res }) => {
    const { password } = await readJson(req);
    if (store.checkServerPassword(password)) {
      const token = uuid();
      authSessions.set(token, Date.now() + 30 * 24 * 3600 * 1000);
      res.setHeader('Set-Cookie', cookie(AUTH_COOKIE, token, { maxAge: 30 * 24 * 3600, httpOnly: true, path: '/', sameSite: 'lax' }));
      return { ok: true };
    }
    throw new HttpError(401, 'wrong password');
  });

  route('POST', '/api/logout', async ({ req, res }) => {
    const token = parseCookies(req.headers.cookie)[AUTH_COOKIE];
    if (token) authSessions.delete(token);
    res.setHeader('Set-Cookie', cookie(AUTH_COOKIE, '', { maxAge: 0, httpOnly: true, path: '/', sameSite: 'lax' }));
    return { ok: true };
  });

  route('GET', '/api/state', async ({ req }) => {
    const unlocked = unlockedIds(req);
    const notebooks = store.listNotebooks().map(n => ({
      ...n, locked: !!n.locked, unlocked: !n.locked || unlocked.has(n.id),
      sections: store.listSections(n.id, unlocked).map(s => ({
        ...s,
        pageCount: store.listPages({ sectionId: s.id }, unlocked).length,
        pageTotal: store.s.pages.filter(p => p.sectionId === s.id && !p.deletedAt).length,
      })),
      pageCount: store.s.pages.filter(p => p.notebookId === n.id && !p.deletedAt).length,
    }));
    return {
      workspace: store.s.workspace,
      settings: { serverName: store.settings.serverName, requireLogin: !!store.settings.requireLogin },
      notebooks,
      tags: store.listTags(),
      stats: await store.stats(),
    };
  });

  route('GET', '/api/settings', async () => ({
    serverName: store.settings.serverName,
    workspaceName: store.s.workspace.name,
    requireLogin: !!store.settings.requireLogin,
    hasPassword: !!store.settings.passwordHash,
  }));

  route('PUT', '/api/settings', async ({ req }) => {
    const patch = await readJson(req);
    const s = store.updateSettings(patch);
    return { serverName: s.serverName, workspaceName: store.s.workspace.name, requireLogin: !!s.requireLogin };
  });

  // ================= notebooks =================

  route('POST', '/api/notebooks', async ({ req }) => {
    const b = await readJson(req);
    return store.createNotebook({ name: b.name, emoji: b.emoji, color: b.color });
  });

  route('PATCH', '/api/notebooks/:id', async ({ req, params }) => {
    requireNotebookAccess(req, params.id);
    const b = await readJson(req);
    const nb = store.updateNotebook(params.id, b);
    if (!nb) throw new HttpError(404, 'notebook not found');
    const { lockSalt, lockHash, ...view } = nb;
    return view;
  });

  route('DELETE', '/api/notebooks/:id', async ({ params, req }) => {
    requireNotebookAccess(req, params.id);
    const nb = await store.deleteNotebook(params.id);
    if (!nb) throw new HttpError(404, 'notebook not found');
    return { ok: true };
  });

  route('POST', '/api/notebooks/:id/lock', async ({ req, params, res }) => {
    const { password } = await readJson(req);
    if (!password || String(password).length < 4) throw new HttpError(400, 'password must be at least 4 characters');
    const existing = store.s.notebooks.find(n => n.id === params.id);
    if (!existing) throw new HttpError(404, 'notebook not found');
    if (existing.locked && !unlockedIds(req).has(existing.id)) throw new HttpError(403, 'unlock the notebook before changing its password', { code: 'locked' });
    store.setNotebookLock(params.id, password);
    const tokens = store.validLockTokens(currentLockTokens(req));
    setLockCookie(res, tokens);
    return { ok: true, locked: true };
  });

  route('POST', '/api/notebooks/:id/unlock', async ({ req, params, res }) => {
    const { password } = await readJson(req);
    if (!store.verifyNotebookPassword(params.id, password)) throw new HttpError(401, 'wrong password');
    const token = store.createLockSession(params.id);
    const tokens = currentLockTokens(req);
    tokens.push(token);
    setLockCookie(res, tokens);
    return { ok: true };
  });

  route('POST', '/api/notebooks/:id/relock', async ({ req, params, res }) => {
    requireNotebookAccess(req, params.id);
    store.relockNotebook(params.id);
    const tokens = store.validLockTokens(currentLockTokens(req));
    setLockCookie(res, tokens);
    return { ok: true };
  });

  // ================= sections =================

  route('POST', '/api/sections', async ({ req }) => {
    const b = await readJson(req);
    requireNotebookAccess(req, b.notebookId);
    if (b.parentSectionId) {
      const parent = requireSectionAccess(req, b.parentSectionId);
      if (parent.notebookId !== b.notebookId) throw new HttpError(400, 'parent section does not belong to notebook');
    }
    return store.createSection({ notebookId: b.notebookId, parentSectionId: b.parentSectionId, name: b.name, color: b.color });
  });

  route('PATCH', '/api/sections/:id', async ({ req, params }) => {
    const current = requireSectionAccess(req, params.id);
    const b = await readJson(req);
    if (b.parentSectionId) {
      const parent = requireSectionAccess(req, b.parentSectionId);
      if (parent.notebookId !== current.notebookId) throw new HttpError(400, 'parent section does not belong to notebook');
    }
    const sec = store.updateSection(params.id, b);
    if (!sec) throw new HttpError(404, 'section not found');
    return sec;
  });

  route('DELETE', '/api/sections/:id', async ({ params, req }) => {
    requireSectionAccess(req, params.id);
    const sec = await store.deleteSection(params.id);
    if (!sec) throw new HttpError(404, 'section not found');
    return { ok: true };
  });

  // ================= pages =================

  route('GET', '/api/pages', async ({ req }) => {
    const q = req.urlParams || {};
    const unlocked = unlockedIds(req);
    return { items: store.listPages({
      notebookId: q.notebookId, sectionId: q.sectionId, parentPageId: q.parentPageId,
      kind: q.kind, favorite: q.favorite !== undefined ? q.favorite === '1' : undefined,
      deleted: q.deleted !== undefined ? q.deleted === '1' : undefined,
      tagId: q.tagId, includeLocked: q.includeLocked === '1',
    }, unlocked) };
  });

  route('POST', '/api/pages', async ({ req }) => {
    const b = await readJson(req);
    if (!b.notebookId) throw new HttpError(400, 'notebookId required');
    const nb = store.s.notebooks.find(n => n.id === b.notebookId);
    if (!nb) throw new HttpError(404, 'notebook not found');
    if (nb.locked && !unlockedIds(req).has(nb.id)) throw new HttpError(403, 'notebook is locked', { code: 'locked' });
    if (b.sectionId) {
      const section = requireSectionAccess(req, b.sectionId);
      if (section.notebookId !== b.notebookId) throw new HttpError(400, 'section does not belong to notebook');
    }
    if (b.parentPageId) {
      const parent = requirePageAccess(req, b.parentPageId);
      if (parent.notebookId !== b.notebookId) throw new HttpError(400, 'parent page does not belong to notebook');
    }
    return store.createPage({
      notebookId: b.notebookId, sectionId: b.sectionId, parentPageId: b.parentPageId,
      kind: b.kind, title: b.title, markdown: b.markdown, icon: b.icon,
    });
  });

  route('GET', '/api/pages/:id', async ({ req, params }) => {
    const unlocked = unlockedIds(req);
    const page = await store.getPageWithBody(params.id, unlocked);
    if(!page)throw new HttpError(404,'page not found');
    return {
      ...page,
      tags: store.pageTagIds(page.id).map(id => store.s.tags.find(t => t.id === id)).filter(Boolean),
      steps: store.listTaskSteps(page.id, unlocked),
      assets: await store.listPageAssets(page.id, unlocked),
      links: store.extractLinks(page.id, page.markdown).map(l => ({ targetPageId: l.targetPageId, title: l.title })),
      backlinks: await store.backlinks(page.id),
      revisionCount: (await store.listRevisions(page.id)).length,
      position: store.getReadingPosition(page.id),
      comments: store.listComments(page.id, unlocked),
    };
  });

  route('PUT', '/api/pages/:id', async ({ req, params }) => {
    const patch = await readJson(req);
    const unlocked = unlockedIds(req);
    const current = store.getPage(params.id, unlocked);
    if (!current) throw new HttpError(404, 'page not found');
    validatePageDestination(req, current, patch);
    const { page, revision, movedPages } = await store.savePage(params.id, patch, unlocked);
    return { ...page, revisionCreated: !!revision, ...(movedPages?.length ? { movedPages } : {}) };
  });

  route('DELETE', '/api/pages/:id', async ({ params, req }) => {
    await store.moveToTrash(params.id, unlockedIds(req));
    return { ok: true };
  });

  route('POST', '/api/pages/:id/restore', async ({ params, req }) => {
    const p = await store.restorePage(params.id, unlockedIds(req));
    return p;
  });

  route('POST', '/api/pages/:id/purge', async ({ params, req }) => {
    await store.purgePage(params.id, unlockedIds(req));
    return { ok: true };
  });

  route('POST', '/api/pages/:id/duplicate', async ({ params, req }) => {
    return store.duplicatePage(params.id, unlockedIds(req));
  });

  route('GET', '/api/pages/:id/backlinks', async ({ params, req }) => {
    requirePageAccess(req, params.id);
    return { items: await store.backlinks(params.id) };
  });

  route('PUT', '/api/pages/:id/tags', async ({ req, params }) => {
    const b = await readJson(req);
    store.setPageTags(params.id, b.tagIds, unlockedIds(req));
    return { ok: true };
  });

  route('GET', '/api/pages/:id/steps', async ({ params, req }) => {
    return { items: store.listTaskSteps(params.id, unlockedIds(req)) };
  });

  route('PUT', '/api/pages/:id/steps', async ({ req, params }) => {
    const b = await readJson(req);
    return { items: store.saveTaskSteps(params.id, b.steps, unlockedIds(req)) };
  });

  route('GET', '/api/pages/:id/revisions', async ({ params, req }) => {
    requirePageAccess(req, params.id);
    return { items: await store.listRevisions(params.id) };
  });

  route('POST', '/api/pages/:id/revisions', async ({ params, req }) => {
    const unlocked = unlockedIds(req);
    const page = store.getPage(params.id, unlocked);
    const rev = await store.createRevision(params.id, { reason: 'manual', icon: page.icon ?? null, title: page.title });
    return rev;
  });

  route('GET', '/api/pages/:id/revisions/:revId', async ({ params, req }) => {
    requirePageAccess(req, params.id);
    return store.getRevision(params.id, params.revId);
  });

  route('POST', '/api/pages/:id/revisions/:revId/restore', async ({ params, req }) => {
    const unlocked = unlockedIds(req);
    requirePageAccess(req, params.id);
    const rev = await store.getRevision(params.id, params.revId);
    const { page } = await store.savePage(params.id, { markdown: rev.markdown, title: rev.title || undefined, icon: rev.icon ?? undefined, reason: 'manual' }, unlocked);
    return { ok: true, page };
  });

  route('GET', '/api/pages/:id/position', async ({ params, req }) => {
    requirePageAccess(req, params.id);
    return store.getReadingPosition(params.id) || { pageId: params.id };
  });

  route('PUT', '/api/pages/:id/position', async ({ req, params }) => {
    requirePageAccess(req, params.id);
    const b = await readJson(req);
    return store.setReadingPosition(params.id, b);
  });

  route('GET', '/api/pages/:id/comments', async ({ params, req }) => {
    return { items: store.listComments(params.id, unlockedIds(req)) };
  });

  route('POST', '/api/pages/:id/comments', async ({ req, params }) => {
    const b = await readJson(req);
    return store.addComment(params.id, b, unlockedIds(req));
  });

  route('DELETE', '/api/comments/:id', async ({ params, req }) => {
    const comment = store.s.comments.find(item => item.id === params.id);
    if (!comment) throw new HttpError(404, 'comment not found');
    requirePageAccess(req, comment.pageId);
    store.deleteComment(params.id);
    return { ok: true };
  });

  // ================= tags =================

  route('GET', '/api/tags', async () => ({ items: store.listTags() }));

  route('POST', '/api/tags', async ({ req }) => {
    const b = await readJson(req);
    return store.createTag({ name: b.name, color: b.color });
  });

  route('PATCH', '/api/tags/:id', async ({ req, params }) => {
    const b = await readJson(req);
    const tag = store.updateTag(params.id, b);
    if (!tag) throw new HttpError(404, 'tag not found');
    return tag;
  });

  route('DELETE', '/api/tags/:id', async ({ params }) => {
    await store.deleteTag(params.id);
    return { ok: true };
  });

  // ================= assets =================

  route('POST', '/api/upload', async ({ req }) => {
    const ct = req.headers['content-type'] || '';
    const m = /boundary=(.+)$/.exec(ct);
    if (!m) throw new HttpError(400, 'multipart/form-data required');
    const buf = await readBody(req, MAX_UPLOAD);
    const fields = parseMultipart(buf, m[1].trim().replace(/^"|"$/g, ''));
    const pageId = field(fields, 'pageId');
    if (!pageId) throw new HttpError(400, 'pageId required');
    const file = fields.find(f => f.filename && f.data.length);
    if (!file) throw new HttpError(400, 'no file provided');
    const unlocked = unlockedIds(req);
    return store.addAsset(pageId, {
      filename: file.filename, mimeType: file.contentType,
      data: file.data,
      width: num(field(fields, 'width')), height: num(field(fields, 'height')),
      duration: num(field(fields, 'duration')),
      caption: field(fields, 'caption'), displayWidth: num(field(fields, 'displayWidth')),
      alignment: field(fields, 'alignment'),
    }, unlocked);
  });

  route('GET', '/api/assets/:id/data', async ({ req, res, params }) => {
    const rec = await store.getAuthorizedAsset(params.id, unlockedIds(req));
    if (!rec) throw new HttpError(403, 'asset is not associated with an accessible page', { code: 'locked' });
    const data = await store.getAssetData(rec.checksum);
    if (!data) throw new HttpError(404, 'asset data missing');
    res.writeHead(200, {
      'Content-Type': rec.mimeType || 'application/octet-stream',
      'Cache-Control': 'private, no-store',
      'Content-Length': data.length,
    });
    res.end(data);
    return null;
  });

  route('GET', '/api/assets/:id', async ({ req, params }) => {
    const rec = await store.getAuthorizedAsset(params.id, unlockedIds(req));
    if (!rec) throw new HttpError(403, 'asset is not associated with an accessible page', { code: 'locked' });
    return rec;
  });

  route('DELETE', '/api/assets/:id', async ({ params, req }) => {
    const ok = await store.deleteAsset(params.id, unlockedIds(req));
    if (!ok) throw new HttpError(404, 'asset not found');
    return { ok: true };
  });

  // ================= search / tasks / reminders / trash / stats =================

  route('GET', '/api/search', async ({ req }) => {
    const q = req.urlParams || {};
    return { items: await store.search(q.q || '', unlockedIds(req)) };
  });

  route('GET', '/api/tasks', async ({ req }) => {
    const q = req.urlParams || {};
    return { items: store.listTasks({ scope: q.scope, includeCompleted: q.includeCompleted === '1' }, unlockedIds(req)) };
  });

  route('GET', '/api/reminders', async ({ req }) => {
    return { items: store.listReminders(unlockedIds(req)) };
  });

  route('GET', '/api/trash', async ({ req }) => {
    const unlocked = unlockedIds(req);
    const items = store.s.pages
      .filter(p => p.deletedAt)
      .map(p => {
        const nb = store.s.notebooks.find(n => n.id === p.notebookId);
        const hidden = !!(nb && nb.locked && !unlocked.has(nb.id));
        if (hidden) return { id: p.id, hidden: true, deletedAt: p.deletedAt, notebookId: p.notebookId };
        return { ...p, notebookName: nb?.name || '?', notebookHidden: !!(nb && nb.locked) };
      })
      .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    return { items };
  });

  route('GET', '/api/stats', async () => store.stats());

  // ================= import / export =================

  route('GET', '/api/export/page/:id', async ({ req, res, params }) => {
    const unlocked = unlockedIds(req);
    const page = await store.getPageWithBody(params.id, unlocked);
    const name = safeName(page.title) + '.md';
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': contentDisposition(name),
    });
    res.end(page.markdown || '');
    return null;
  });

  route('GET', '/api/export/all', async ({ req, res }) => {
    const unlocked = unlockedIds(req);
    const files = [];
    const usedPaths = new Set();
    for (const nb of store.listNotebooks()) {
      if (nb.locked && !unlocked.has(nb.id)) continue;
      const nbName = safeName(nb.name);
      const sections = store.listSections(nb.id, unlocked);
      const secName = new Map(sections.map(s => [s.id, safeName(s.name)]));
      for (const p of store.listPages({ notebookId: nb.id }, unlocked)) {
        const body = await store.readBody(p.id);
        const dir = [nbName, p.sectionId ? secName.get(p.sectionId) : null].filter(Boolean).join('/');
        const stem = safeName(p.title);
        let name = dir + '/' + stem + '.md';
        if (usedPaths.has(name)) name = dir + '/' + stem + ' (' + p.id.slice(0, 8) + ').md';
        let suffix = 2;
        while (usedPaths.has(name)) name = dir + '/' + stem + ' (' + p.id.slice(0, 8) + '-' + suffix++ + ').md';
        usedPaths.add(name);
        files.push({ name, data: body });
      }
    }
    const zip = buildZip(files);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition('notebook-export.zip'),
    });
    res.end(zip);
    return null;
  });

  route('POST', '/api/import', async ({ req }) => {
    const ct = req.headers['content-type'] || '';
    const m = /boundary=(.+)$/.exec(ct);
    if (!m) throw new HttpError(400, 'multipart/form-data required');
    const buf = await readBody(req, MAX_UPLOAD);
    const fields = parseMultipart(buf, m[1].trim().replace(/^"|"$/g, ''));
    const notebookId = field(fields, 'notebookId');
    if (!notebookId) throw new HttpError(400, 'notebookId required');
    const nb = store.s.notebooks.find(n => n.id === notebookId);
    if (!nb) throw new HttpError(404, 'notebook not found');
    if (nb.locked && !unlockedIds(req).has(nb.id)) throw new HttpError(403, 'locked');
    const files = fields.filter(f => f.filename && f.data.length);
    const byPath = new Map();
    for (const f of files) {
      if (/.zip$/i.test(f.filename)) {
        const entries = readZip(f.data);
        for (const [name, data] of entries) {
          if (/.(md|markdown|txt)$/i.test(name)) byPath.set(name, data.toString('utf8'));
        }
      } else if (/.(md|markdown|txt)$/i.test(f.filename)) {
        byPath.set(f.filename, f.data.toString('utf8'));
      }
    }
    let created = 0;
    for (const [name, body] of byPath) {
      const title = stripMarkdown(name.split('/').pop().replace(/\.(md|markdown|txt)$/i, '')).trim() || 'Imported';
      await store.createPage({ notebookId, title, markdown: body, kind: 'document' });
      created++;
    }
    return { ok: true, created };
  });

  route('GET', '/api/backup', async ({ req, res }) => {
    const unlocked = unlockedIds(req);
    const locked = store.s.notebooks.filter(notebook => notebook.locked && !unlocked.has(notebook.id));
    if (locked.length) throw new HttpError(403, 'unlock all private notebooks before creating a complete backup', { code: 'locked' });
    await store.flush();
    const zip = buildZip(await store.createBackupFiles());
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition('notebook-backup.zip'),
      'Cache-Control': 'private, no-store',
      'Content-Length': zip.length,
    });
    res.end(zip);
    return null;
  });

  route('POST', '/api/backup/restore', async ({ req }) => {
    const ct = req.headers['content-type'] || '';
    const m = /boundary=(.+)$/.exec(ct);
    if (!m) throw new HttpError(400, 'multipart/form-data required');
    const buf = await readBody(req, MAX_UPLOAD);
    const fields = parseMultipart(buf, m[1].trim().replace(/^"|"$/g, ''));
    const file = fields.find(item => item.filename && item.data.length);
    if (!file) throw new HttpError(400, 'backup file required');
    const result = await store.restoreBackup(readZip(file.data));
    return { ok: true, restored: result };
  });

  route('GET','/api/diagnostics/export',async({res})=>{
    const data=await store.diagnostics.exportLogs();
    res.writeHead(200,{'Content-Type':'application/x-ndjson','Content-Disposition':contentDisposition('notebook-diagnostics.jsonl'),'Cache-Control':'no-store'});
    res.end(data);return null;
  });

  // ---------- dispatcher ----------

  async function handle(req, res, pathname, urlParams) {
    if (!pathname.startsWith('/api/')) return false;
    req.urlParams = urlParams;
    const candidate=req.headers['x-request-id'];
    const operationId=typeof candidate==='string' && /^[a-f0-9-]{36}$/i.test(candidate)?candidate:randomUUID();
    res.setHeader('X-Request-Id',operationId);
    const start=performance.now();let requestError;
    const record=()=>{const durationMs=performance.now()-start;if(req.method!=='GET'||res.statusCode>=400||durationMs>=1000){
      void store.diagnostics.record('http.request',{operationId,method:req.method,route:req.diagnosticRoute||'/api/unmatched',resourceRef:req.diagnosticResource,status:res.statusCode,durationMs,level:res.statusCode>=500?'error':res.statusCode>=400?'warning':'info',error:requestError});
    }};
    res.once('finish',record);
    res.once('close',()=>{if(!res.writableFinished)void store.diagnostics.record('http.aborted',{operationId,method:req.method,route:req.diagnosticRoute||'/api/unmatched',durationMs:performance.now()-start,level:'warning'});});
    try {
      const result = await dispatch(req.method, pathname, req, res);
      if (result === null) return true; // response already ended
      const body = JSON.stringify(result);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
      return true;
    } catch (err) {
      if (res.writableEnded) return true;
      const status = err.status || 500;
      requestError=err;
      const body = JSON.stringify({ error: err.message || 'internal error', ...(err.extra || {}) });
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
      return true;
    }
  }

  return { handle };
}
