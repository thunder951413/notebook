import fs from 'node:fs/promises';
import path from 'node:path';
import { createDiagnostics } from './diagnostics.js';
import { uuid, isoNow, nextIso, sha256, hashPassword, newToken, safeName, stripMarkdown } from './util.js';

const AUTOSAVE_REV_INTERVAL_MS = 5 * 60 * 1000;   // snapshot at most every 5 min
const AUTOSAVE_REV_MAX_AGE_MS = 24 * 60 * 60 * 1000; // ...unless last snapshot is older than 24h
const MAX_REVISIONS_PER_PAGE = 100;
const PREVIEW_LEN = 160;

export class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.diagnostics = createDiagnostics(path.join(dataDir,'diagnostics'));
    this.pagesDir = path.join(dataDir, 'pages');
    this.revsDir = path.join(dataDir, 'revisions');
    this.assetsDir = path.join(dataDir, 'assets');
    this.indexPath = path.join(dataDir, 'index.json');
    this.metaPath = path.join(dataDir, 'meta.json');
    this.s = {
      workspace: { id: uuid(), name: 'My Notebook', createdAt: isoNow(), updatedAt: isoNow() },
      notebooks: [], sections: [], pages: [], tags: [], pageTags: [],
      taskSteps: [], comments: [], readingPositions: [], assets: [],
      lockSessions: [], // {token, notebookId, expiresAt}
      deletedNotebooks: [], // recent notebook trash for cascaded pages
    };
    this.settings = { requireLogin: false, passwordHash: null, passwordSalt: null, serverName: 'Notebook Server' };
    this._saveTimer = null;
    this._dirty = false;
    this._changeVersion = 0;
    this._savePromise = Promise.resolve();
    this._saveError = null;
    this._pageWrites = new Map();
    // title -> pageId cache for [[links]]
    this._titleIndex = null;
    this._linkDirty = true;
  }

  // ---------- boot / persist ----------

  async init() {
    await fs.mkdir(this.pagesDir, { recursive: true });
    await fs.mkdir(this.revsDir, { recursive: true });
    await fs.mkdir(this.assetsDir, { recursive: true });
    const data = await readOptionalJson(this.indexPath, 'notebook index');
    if (data !== undefined) {
      validatePersistedState(data);
      for (const k of ['workspace', 'notebooks', 'sections', 'pages', 'tags', 'pageTags', 'taskSteps', 'comments', 'readingPositions', 'lockSessions', 'deletedNotebooks']) {
        if (data[k] !== undefined) this.s[k] = data[k];
      }
      if (data.assets !== undefined) this.s.assets = data.assets;
      validateStateShape(this.s);
    }
    const settings = await readOptionalJson(this.metaPath, 'server settings');
    if (settings !== undefined) {
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('server settings are invalid; refusing to start');
      this.settings = { ...this.settings, ...settings };
    }
    this._cleanupExpiredSessions();
    // Remove now-dangling reading positions
    const pageIds = new Set(this.s.pages.map(p => p.id));
    this.s.readingPositions = this.s.readingPositions.filter(r => pageIds.has(r.pageId));
  }

  _scheduleSave() {
    this._dirty = true;
    this._changeVersion++;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow().catch(err => {
        this._saveError = err;
        void this.diagnostics.record('storage.persist.failed',{level:'error',error:err});
      });
    }, 150);
  }

  async saveNow() {
    this._savePromise = this._savePromise.catch(() => {}).then(async () => {
      if (!this._dirty) {
        if (this._saveError) throw this._saveError;
        return;
      }
      const version = this._changeVersion;
      await atomicWrite(this.indexPath, JSON.stringify(this.s));
      await atomicWrite(this.metaPath, JSON.stringify(this.settings));
      if (version === this._changeVersion) this._dirty = false;
      this._saveError = null;
    });
    try { return await this._savePromise; }
    catch (err) { this._saveError = err;void this.diagnostics.record('storage.persist.failed',{level:'error',error:err});throw err; }
  }

  async flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    await this.saveNow();
  }

  _cleanupExpiredSessions() {
    const now = Date.now();
    this.s.lockSessions = this.s.lockSessions.filter(x => new Date(x.expiresAt).getTime() > now);
  }

  // ---------- page bodies ----------

  bodyPath(pageId) { return path.join(this.pagesDir, pageId + '.md'); }

  async readBody(pageId) {
    try { return await fs.readFile(this.bodyPath(pageId), 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') return ''; throw err; }
  }

  async writeBody(pageId, markdown) {
    await atomicWrite(this.bodyPath(pageId), markdown ?? '');
  }

  async deleteBody(pageId) {
    try { await fs.unlink(this.bodyPath(pageId)); } catch {}
  }

  // ---------- revisions ----------

  revDir(pageId) { return path.join(this.revsDir, pageId); }

  async createRevision(pageId, { reason = 'autosave', icon, title } = {}) {
    const body = await this.readBody(pageId);
    const revId = uuid();
    const rec = { id: revId, pageId, createdAt: isoNow(), reason, icon: icon ?? null, title: title ?? null };
    const dir = this.revDir(pageId);
    await fs.mkdir(dir, { recursive: true });
    await atomicWrite(path.join(dir, revId + '.md'), body);
    await atomicWrite(path.join(dir, revId + '.json'), JSON.stringify(rec));
    await this._pruneRevisions(pageId);
    return rec;
  }

  async _pruneRevisions(pageId) {
    const dir = this.revDir(pageId);
    let names;
    try { names = await fs.readdir(dir); } catch { return; }
    const jsons = names.filter(n => n.endsWith('.json'));
    if (jsons.length <= MAX_REVISIONS_PER_PAGE) return;
    const recs = [];
    for (const n of jsons) {
      try { recs.push({ n, rec: JSON.parse(await fs.readFile(path.join(dir, n), 'utf8')) }); }
      catch { try { await fs.unlink(path.join(dir, n)); } catch {} }
    }
    recs.sort((a, b) => a.rec.createdAt.localeCompare(b.rec.createdAt));
    const drop = recs.slice(0, recs.length - MAX_REVISIONS_PER_PAGE);
    for (const { n, rec } of drop) {
      try { await fs.unlink(path.join(dir, n)); } catch {}
      try { await fs.unlink(path.join(dir, rec.id + '.md')); } catch {}
    }
  }

  async listRevisions(pageId) {
    const dir = this.revDir(pageId);
    let names;
    try { names = await fs.readdir(dir); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      try { out.push(JSON.parse(await fs.readFile(path.join(dir, n), 'utf8'))); } catch {}
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  }

  async getRevision(pageId, revId) {
    const rec = JSON.parse(await fs.readFile(path.join(this.revDir(pageId), revId + '.json'), 'utf8'));
    const markdown = await fs.readFile(path.join(this.revDir(pageId), revId + '.md'), 'utf8');
    return { ...rec, markdown };
  }

  async deleteRevisions(pageId) {
    const dir = this.revDir(pageId);
    try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
  }

  // ---------- [[link]] index ----------

  _rebuildLinkCacheIfDirty() {
    if (!this._linkDirty && this._titleIndex) return;
    const titles = new Map();
    const byId = new Map();
    for (const p of this.s.pages) {
      if (p.deletedAt) continue;
      byId.set(p.id, p);
      const t = p.title.trim().toLowerCase();
      if (t) {
        if (!titles.has(t)) titles.set(t, []);
        titles.get(t).push(p.id);
      }
    }
    this._titleIndex = { titles, byId };
    this._linkDirty = false;
  }

  /** Resolve a [[wiki-style title]] reference to page ids (unlocked notebooks only). */
  resolveTitle(title) {
    this._rebuildLinkCacheIfDirty();
    const t = String(title).trim().toLowerCase();
    if (!t) return [];
    return (this._titleIndex.titles.get(t) || []).filter(id => {
      const p = this._titleIndex.byId.get(id);
      if (!p) return false;
      const nb = this.s.notebooks.find(n => n.id === p.notebookId);
      return !(nb && nb.locked);
    });
  }

  /** All outgoing links of a page body: [{targetPageId, title}] */
  extractLinks(pageId, markdown) {
    this._rebuildLinkCacheIfDirty();
    const out = [];
    const re = /\[\[([^\]\n]+?)\]\]/g;
    let m;
    while ((m = re.exec(markdown || '')) !== null) {
      const title = m[1].split('|')[0].trim();
      const ids = this.resolveTitle(title);
      for (const id of ids) {
        if (id !== pageId) out.push({ targetPageId: id, title });
      }
    }
    return out;
  }

  /** Backlinks: pages whose body references this page's title. */
  async backlinks(pageId) {
    this._rebuildLinkCacheIfDirty();
    const page = this.s.pages.find(p => p.id === pageId);
    if (!page) return [];
    const out = [];
    const title = page.title.trim().toLowerCase();
    if (!title) return out;
    for (const p of this.s.pages) {
      if (p.deletedAt || p.id === pageId) continue;
      const nb = this.s.notebooks.find(n => n.id === p.notebookId);
      if (nb && nb.locked) continue;
      const body = await this.readBody(p.id);
      if (body && body.toLowerCase().includes('[[' + title + ']')) {
        out.push({ pageId: p.id, title: p.title, notebookId: p.notebookId, sectionId: p.sectionId, excerpt: this._excerptAround(body, title) });
      }
    }
    return out;
  }

  _excerptAround(body, title) {
    const idx = body.toLowerCase().indexOf('[[' + title);
    if (idx < 0) return '';
    const start = Math.max(0, idx - 60);
    return stripMarkdown(body.slice(start, idx + title.length + 2 + 60));
  }

  // ---------- notebooks ----------

  listNotebooks() {
    return this.s.notebooks
      .filter(n => !n.deletedAt)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt))
      .map(n => ({ ...n, lockSalt: undefined, lockHash: undefined }));
  }

  createNotebook({ name, emoji, color }) {
    const nb = {
      id: uuid(), workspaceId: this.s.workspace.id, name: String(name || 'Untitled'),
      emoji: emoji || '📓', color: color || null, sortOrder: this.s.notebooks.length,
      createdAt: isoNow(), updatedAt: isoNow(), locked: false,
    };
    this.s.notebooks.push(nb);
    this._scheduleSave();
    return nb;
  }

  updateNotebook(id, patch) {
    const nb = this.s.notebooks.find(n => n.id === id);
    if (!nb) return null;
    for (const k of ['name', 'emoji', 'color', 'sortOrder']) {
      if (patch[k] !== undefined) nb[k] = patch[k];
    }
    nb.updatedAt = isoNow();
    this._scheduleSave();
    return nb;
  }

  /** Soft-delete notebook: cascade pages & sections into trash. */
  async deleteNotebook(id) {
    const nb = this.s.notebooks.find(n => n.id === id);
    if (!nb) return null;
    const now = isoNow();
    nb.deletedAt = now;
    for (const sec of this.s.sections) {
      if (sec.notebookId === id && !sec.deletedAt) sec.deletedAt = now;
    }
    for (const p of this.s.pages) {
      if (p.notebookId === id && !p.deletedAt) p.deletedAt = now;
    }
    this.s.deletedNotebooks.push({ id: nb.id, name: nb.name, deletedAt: now });
    this._scheduleSave();
    return nb;
  }

  // ---------- private lock ----------

  setNotebookLock(id, password) {
    const nb = this.s.notebooks.find(n => n.id === id);
    if (!nb) return null;
    if (password) {
      const salt = sha256(uuid());
      nb.lockSalt = salt;
      nb.lockHash = hashPassword(password, salt);
    }
    nb.locked = !!password;
    nb.updatedAt = isoNow();
    // revoke existing sessions for this notebook
    this.s.lockSessions = this.s.lockSessions.filter(x => x.notebookId !== id);
    this._scheduleSave();
    return nb;
  }

  verifyNotebookPassword(id, password) {
    const nb = this.s.notebooks.find(n => n.id === id);
    if (!nb || !nb.locked || !nb.lockHash) return false;
    return hashPassword(String(password), nb.lockSalt) === nb.lockHash;
  }

  createLockSession(notebookId) {
    this._cleanupExpiredSessions();
    const token = newToken();
    const expiresAt = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
    this.s.lockSessions.push({ token, notebookId, expiresAt });
    this._scheduleSave();
    return token;
  }

  /** notebook ids unlocked by this token (or all if not locked) */
  unlockedNotebookIds(tokens) {
    this._cleanupExpiredSessions();
    const allowed = new Set(Array.isArray(tokens) ? tokens : [tokens]);
    const set = new Set();
    for (const x of this.s.lockSessions) {
      if (allowed.has(x.token) && new Date(x.expiresAt).getTime() > Date.now()) set.add(x.notebookId);
    }
    return set;
  }

  validLockTokens(tokens) {
    this._cleanupExpiredSessions();
    const valid = new Set(this.s.lockSessions.map(x => x.token));
    return tokens.filter(token => valid.has(token));
  }

  isNotebookAccessible(notebookId, unlockedIds) {
    const nb = this.s.notebooks.find(n => n.id === notebookId);
    if (!nb || !nb.locked) return true;
    return unlockedIds.has(notebookId);
  }

  relockNotebook(id) {
    const nb = this.s.notebooks.find(n => n.id === id);
    if (!nb) return null;
    this.s.lockSessions = this.s.lockSessions.filter(x => x.notebookId !== id);
    this._scheduleSave();
    return nb;
  }

  // ---------- sections ----------

  listSections(notebookId, unlockedIds) {
    const nb = this.s.notebooks.find(n => n.id === notebookId);
    if (nb && nb.locked && !unlockedIds.has(notebookId)) return [];
    return this.s.sections
      .filter(x => x.notebookId === notebookId && !x.deletedAt)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
  }

  createSection({ notebookId, parentSectionId, name, color }) {
    const sec = {
      id: uuid(), notebookId, parentSectionId: parentSectionId || undefined,
      name: String(name || 'New Section'), color: color || null, sortOrder: this.s.sections.length,
      createdAt: isoNow(), updatedAt: isoNow(),
    };
    this._validateSectionPlacement(sec);
    this.s.sections.push(sec);
    this._scheduleSave();
    return sec;
  }

  updateSection(id, patch) {
    const sec = this.s.sections.find(x => x.id === id);
    if (!sec) return null;
    const parentSectionId = patch.parentSectionId !== undefined ? patch.parentSectionId || undefined : sec.parentSectionId;
    this._validateSectionPlacement({ ...sec, parentSectionId });
    for (const k of ['name', 'color', 'sortOrder', 'parentSectionId']) {
      if (patch[k] !== undefined) sec[k] = patch[k] === null ? undefined : patch[k];
    }
    sec.updatedAt = isoNow();
    this._scheduleSave();
    return sec;
  }

  _validateSectionPlacement(section) {
    if (!this.s.notebooks.some(item => item.id === section.notebookId)) throw placementError('notebook not found');
    validateParentPlacement(this.s.sections, section, 'parentSectionId', 'section');
  }

  _validatePagePlacement(page) {
    if (!this.s.notebooks.some(item => item.id === page.notebookId)) throw placementError('notebook not found');
    if (page.sectionId) {
      const section = this.s.sections.find(item => item.id === page.sectionId);
      if (!section || section.notebookId !== page.notebookId) throw placementError('section does not belong to notebook');
    }
    validateParentPlacement(this.s.pages, page, 'parentPageId', 'page');
    if (page.parentPageId) {
      const parent = this.s.pages.find(item => item.id === page.parentPageId);
      if ((parent.sectionId || undefined) !== (page.sectionId || undefined)) throw placementError('parent page does not belong to section');
    }
  }

  _pageDescendants(id) {
    const ids = new Set([id]);
    const children = new Map();
    for (const page of this.s.pages) {
      if (!children.has(page.parentPageId)) children.set(page.parentPageId, []);
      children.get(page.parentPageId).push(page);
    }
    const pending = [id];
    for (let index = 0; index < pending.length; index++) {
      for (const child of children.get(pending[index]) || []) {
        if (ids.has(child.id)) continue;
        ids.add(child.id);pending.push(child.id);
      }
    }
    ids.delete(id);
    return this.s.pages.filter(page => ids.has(page.id));
  }

  async deleteSection(id) {
    const sec = this.s.sections.find(x => x.id === id);
    if (!sec) return null;
    const now = isoNow();
    const affected = new Set([id]);
    // include descendant sections
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of this.s.sections) {
        if (!x.deletedAt && x.parentSectionId && affected.has(x.parentSectionId) && !affected.has(x.id)) {
          affected.add(x.id); grew = true;
        }
      }
    }
    for (const x of this.s.sections) {
      if (affected.has(x.id)) x.deletedAt = now;
    }
    for (const p of this.s.pages) {
      if (p.sectionId && affected.has(p.sectionId) && !p.deletedAt) p.deletedAt = now;
    }
    sec.deletedAt = now;
    this._scheduleSave();
    return sec;
  }

  // ---------- pages ----------

  /** page -> public shape (no internal lock fields) */
  _pageView(p, unlockedIds) {
    const nb = this.s.notebooks.find(n => n.id === p.notebookId);
    const locked = !!(nb && nb.locked && !unlockedIds.has(nb.id));
    const out = { ...p };
    if (locked) {
      // hide sensitive meta while locked
      out.locked = true;
      out.title = '🔒 Locked page';
      delete out.reminderAt; delete out.recurrenceRule; delete out.dueAt;
      delete out.completedAt; delete out.important; delete out.preview;
    }
    return out;
  }

  _pageFilter(scope, unlockedIds) {
    const { notebookId, sectionId, parentPageId, kind, favorite, deleted, tagId, includeLocked } = scope;
    let pages = this.s.pages;
    if (notebookId !== undefined) pages = pages.filter(p => p.notebookId === notebookId);
    if (sectionId !== undefined) pages = pages.filter(p => p.sectionId === sectionId);
    if (parentPageId === 'null') pages = pages.filter(p => !p.parentPageId);
    else if (parentPageId !== undefined) pages = pages.filter(p => p.parentPageId === parentPageId);
    if (kind) pages = pages.filter(p => p.kind === kind);
    if (favorite !== undefined) pages = pages.filter(p => !!p.favorite === !!favorite);
    if (deleted !== undefined) pages = pages.filter(p => !!p.deletedAt === !!deleted);
    if (tagId) {
      const ids = new Set(this.s.pageTags.filter(t => t.tagId === tagId).map(t => t.pageId));
      pages = pages.filter(p => ids.has(p.id));
    }
    if (!includeLocked) {
      const lockedNbs = new Set(this.s.notebooks.filter(n => n.locked && !unlockedIds.has(n.id)).map(n => n.id));
      pages = pages.filter(p => !lockedNbs.has(p.notebookId));
    }
    return pages;
  }

  listPages(scope = {}, unlockedIds = new Set()) {
    const pages = this._pageFilter(scope, unlockedIds)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || b.updatedAt.localeCompare(a.updatedAt));
    return pages.map(p => this._pageView(p, unlockedIds));
  }

  getPage(id, unlockedIds = new Set()) {
    const p = this.s.pages.find(x => x.id === id);
    if (!p) return null;
    const nb = this.s.notebooks.find(n => n.id === p.notebookId);
    if (nb && nb.locked && !unlockedIds.has(nb.id)) {
      const err = new Error('notebook is locked');
      err.status = 403;
      err.code = 'locked';
      throw err;
    }
    return p;
  }

  async getPageWithBody(id, unlockedIds) {
    const p = this.getPage(id, unlockedIds);
    if(!p)return null;
    const markdown = await this.readBody(id);
    return { ...p, markdown };
  }

  async createPage({ notebookId, sectionId, parentPageId, kind, title, markdown, icon }) {
    const now = isoNow();
    const body = markdown ?? '';
    const derivedTitle = title || firstHeading(body) || 'Untitled';
    const page = {
      id: uuid(), notebookId, sectionId: sectionId || undefined, parentPageId: parentPageId || undefined,
      icon: icon || null, kind: kind === 'task' ? 'task' : 'document', title: derivedTitle,
      preview: makePreview(body), favorite: false,
      sortOrder: this.s.pages.filter(p => p.sectionId === sectionId && !p.parentPageId).length,
      createdAt: now, updatedAt: now,
    };
    if (parentPageId && sectionId === undefined) page.sectionId = this.s.pages.find(item => item.id === parentPageId)?.sectionId;
    this._validatePagePlacement(page);
    this.s.pages.push(page);
    try {
      await this.writeBody(page.id, body);
      await this.createRevision(page.id, { reason: 'autosave' });
    } catch (err) {
      this.s.pages = this.s.pages.filter(item => item !== page);
      await this.deleteBody(page.id);
      await this.deleteRevisions(page.id);
      throw err;
    }
    this._scheduleSave();
    return page;
  }

  /** Save page meta + body, returning the page, revision and moved descendants. */
  async savePage(id, patch, unlockedIds) {
    const previous = this._pageWrites.get(id) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => this._savePage(id, patch, unlockedIds));
    this._pageWrites.set(id, task);
    try { return await task; }
    finally { if (this._pageWrites.get(id) === task) this._pageWrites.delete(id); }
  }

  async _savePage(id, patch, unlockedIds) {
    const p = this.getPage(id, unlockedIds);
    if (patch.expectedUpdatedAt !== undefined && patch.expectedUpdatedAt !== p.updatedAt) {
      const err = new Error('page was updated by another client');
      err.status = 409;
      err.extra = { code: 'conflict', currentUpdatedAt: p.updatedAt };
      throw err;
    }
    const oldBody = await this.readBody(id);
    const newBody = patch.markdown !== undefined ? patch.markdown : oldBody;
    const nextPage = { ...p };
    let changed = newBody !== oldBody;
    for (const k of ['title', 'icon', 'favorite', 'kind', 'important', 'completedAt', 'reminderAt', 'recurrenceRule', 'dueAt', 'parentPageId', 'sortOrder', 'sectionId', 'assigneeIds', 'notebookId']) {
      if (patch[k] !== undefined) {
        const next = patch[k] === null ? undefined : patch[k];
        if (!sameValue(nextPage[k], next)) {
          changed = true;
          if (next === undefined) delete nextPage[k];
          else nextPage[k] = next;
        }
      }
    }
    // An explicit title always wins. Body-only saves may derive a title from H1.
    if (patch.title === undefined && newBody !== oldBody) {
      const h = firstHeading(newBody);
      if (h && h !== nextPage.title) { nextPage.title = h; changed = true; }
    }
    const preview = makePreview(newBody);
    if (preview !== nextPage.preview) { nextPage.preview = preview; changed = true; }
    if (!changed) return { page: p, revision: null };
    this._validatePagePlacement(nextPage);
    const moved = nextPage.notebookId !== p.notebookId || nextPage.sectionId !== p.sectionId;
    const descendants = moved ? this._pageDescendants(id) : [];
    for (const child of descendants) this.getPage(child.id, unlockedIds);
    nextPage.updatedAt = nextIso(p.updatedAt);
    let rev = null;
    try {
      if (newBody !== oldBody) await this.writeBody(id, newBody);
      if (newBody !== oldBody || patch.title !== undefined) {
        const recs = await this.listRevisions(id);
        const last = recs[0];
        const lastTs = last ? new Date(last.createdAt).getTime() : 0;
        const now = Date.now();
        if (patch.reason === 'manual') {
          rev = await this.createRevision(id, { reason: 'manual', icon: nextPage.icon ?? null, title: nextPage.title });
        } else if (!last || now - lastTs > AUTOSAVE_REV_INTERVAL_MS || now - lastTs > AUTOSAVE_REV_MAX_AGE_MS) {
          rev = await this.createRevision(id, { reason: 'autosave', icon: nextPage.icon ?? null, title: nextPage.title });
        }
      }
    } catch (err) {
      if (newBody !== oldBody) {
        try { await this.writeBody(id, oldBody); }
        catch (rollbackError) { rollbackError.cause = err; throw rollbackError; }
      }
      throw err;
    }
    const index = this.s.pages.indexOf(p);
    if (index < 0) throw new Error('page disappeared during save');
    this.s.pages[index] = nextPage;
    for (const child of descendants) {
      child.notebookId = nextPage.notebookId;
      child.sectionId = nextPage.sectionId;
      child.updatedAt = nextIso(child.updatedAt);
    }
    if (nextPage.title !== p.title || nextPage.notebookId !== p.notebookId) this._linkDirty = true;
    this._scheduleSave();
    return { page: nextPage, revision: rev, movedPages: descendants };
  }

  async moveToTrash(id, unlockedIds) {
    const p = this.getPage(id, unlockedIds);
    if (p.deletedAt) return p;
    p.deletedAt = isoNow();
    this._scheduleSave();
    return p;
  }

  async restorePage(id, unlockedIds) {
    const p = this.getPage(id, unlockedIds);
    delete p.deletedAt;
    p.updatedAt = isoNow();
    this._scheduleSave();
    return p;
  }

  async purgePage(id, unlockedIds) {
    const p = this.getPage(id, unlockedIds);
    // Keep surviving children reachable and backups restorable after a parent
    // is permanently removed. Soft deletion retains the existing tree.
    const children = this.s.pages.filter(page => page.parentPageId === id);
    for (const child of children) this.getPage(child.id, unlockedIds);
    for (const child of children) {
      child.parentPageId = p.parentPageId;
      child.updatedAt = nextIso(child.updatedAt);
    }
    const idx = this.s.pages.indexOf(p);
    if (idx >= 0) this.s.pages.splice(idx, 1);
    this.s.pageTags = this.s.pageTags.filter(t => t.pageId !== id);
    this.s.taskSteps = this.s.taskSteps.filter(t => t.pageId !== id);
    this.s.comments = this.s.comments.filter(c => c.pageId !== id);
    this.s.readingPositions = this.s.readingPositions.filter(r => r.pageId !== id);
    await this.deleteBody(id);
    await this.deleteRevisions(id);
    // drop orphaned assets
    const assets = this.s.assets ? this.s.assets : [];
    for (const a of assets) {
      if (a.pageId === id) await this.deleteAsset(a.id);
    }
    this._scheduleSave();
    return true;
  }

  async duplicatePage(id, unlockedIds) {
    const p = this.getPage(id, unlockedIds);
    const body = await this.readBody(id);
    const now = isoNow();
    const np = {
      ...p,
      id: uuid(),
      title: p.title + ' (copy)',
      favorite: false,
      createdAt: now, updatedAt: now,
      deletedAt: undefined,
      completedAt: undefined,
      reminderAt: undefined,
    };
    delete np.deletedAt;
    this.s.pages.push(np);
    await this.writeBody(np.id, body);
    // duplicate steps + tags
    for (const st of this.s.taskSteps.filter(t => t.pageId === id)) {
      this.s.taskSteps.push({ ...st, id: uuid(), pageId: np.id, createdAt: now });
    }
    for (const tg of this.s.pageTags.filter(t => t.pageId === id)) {
      this.s.pageTags.push({ pageId: np.id, tagId: tg.tagId });
    }
    this._scheduleSave();
    return np;
  }

  // ---------- tags ----------

  listTags() {
    return this.s.tags.filter(t => !t.deletedAt).sort((a, b) => a.name.localeCompare(b.name));
  }

  createTag({ name, color }) {
    const tag = { id: uuid(), name: String(name || 'tag'), color: color || null, createdAt: isoNow(), updatedAt: isoNow() };
    this.s.tags.push(tag);
    this._scheduleSave();
    return tag;
  }

  updateTag(id, patch) {
    const tag = this.s.tags.find(t => t.id === id);
    if (!tag) return null;
    for (const k of ['name', 'color']) if (patch[k] !== undefined) tag[k] = patch[k];
    tag.updatedAt = isoNow();
    this._scheduleSave();
    return tag;
  }

  async deleteTag(id) {
    const tag = this.s.tags.find(t => t.id === id);
    if (!tag) return null;
    tag.deletedAt = isoNow();
    this.s.pageTags = this.s.pageTags.filter(t => t.tagId !== id);
    this._scheduleSave();
    return tag;
  }

  pageTagIds(pageId) {
    return this.s.pageTags.filter(t => t.pageId === pageId).map(t => t.tagId);
  }

  setPageTags(pageId, tagIds, unlockedIds) {
    this.getPage(pageId, unlockedIds);
    const ids = new Set(tagIds || []);
    this.s.pageTags = this.s.pageTags.filter(t => t.pageId !== pageId);
    for (const id of ids) this.s.pageTags.push({ pageId, tagId: id });
    this._scheduleSave();
  }

  // ---------- task steps ----------

  listTaskSteps(pageId, unlockedIds) {
    this.getPage(pageId, unlockedIds);
    return this.s.taskSteps
      .filter(t => t.pageId === pageId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
  }

  saveTaskSteps(pageId, steps, unlockedIds) {
    this.getPage(pageId, unlockedIds);
    const now = isoNow();
    const existing = new Map(this.s.taskSteps.filter(t => t.pageId === pageId).map(t => [t.id, t]));
    const next = [];
    (steps || []).forEach((st, i) => {
      const id = st.id && existing.has(st.id) ? st.id : uuid();
      next.push({ id, pageId, text: String(st.text || ''), checked: !!st.checked, sortOrder: i, createdAt: existing.get(id)?.createdAt || now });
    });
    this.s.taskSteps = this.s.taskSteps.filter(t => t.pageId !== pageId).concat(next);
    this._scheduleSave();
    return next;
  }

  // ---------- comments ----------

  listComments(pageId, unlockedIds) {
    this.getPage(pageId, unlockedIds);
    return this.s.comments.filter(c => c.pageId === pageId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  addComment(pageId, { authorName, body }, unlockedIds) {
    this.getPage(pageId, unlockedIds);
    const c = { id: uuid(), pageId, authorName: authorName || 'Anonymous', body: String(body || ''), createdAt: isoNow(), updatedAt: isoNow() };
    this.s.comments.push(c);
    this._scheduleSave();
    return c;
  }

  deleteComment(id) {
    const idx = this.s.comments.findIndex(c => c.id === id);
    if (idx < 0) return false;
    this.s.comments.splice(idx, 1);
    this._scheduleSave();
    return true;
  }

  // ---------- assets ----------

  async addAsset(pageId, { filename, mimeType, kind, data, width, height, duration, caption, displayWidth, alignment }, unlockedIds) {
    this.getPage(pageId, unlockedIds);
    const checksum = sha256(data);
    const blobPath = path.join(this.assetsDir, checksum);
    const recPath = path.join(this.assetsDir, checksum + '.json');
    let rec = null;
    try { rec = JSON.parse(await fs.readFile(recPath, 'utf8')); } catch {}
    if (!rec) {
      // content-addressed identity: the asset id IS the checksum
      rec = { id: checksum, checksum, kind: kind || guessKind(mimeType, filename), filename: safeName(filename), mimeType, byteSize: data.length, width, height, duration, createdAt: isoNow() };
      await atomicWrite(blobPath, data);
      await atomicWrite(recPath, JSON.stringify(rec));
    }
    const link = {
      id: uuid(), pageId, assetId: rec.id, filename: safeName(filename), mimeType: mimeType || rec.mimeType,
      caption: caption ?? null, displayWidth: displayWidth ?? null, alignment: alignment ?? null,
      createdAt: isoNow(),
    };
    this.s.assets = this.s.assets || [];
    this.s.assets.push(link);
    this._scheduleSave();
    return { ...rec, ...link, assetId: rec.id };
  }

  async listPageAssets(pageId, unlockedIds) {
    this.getPage(pageId, unlockedIds);
    const out = [];
    for (const link of (this.s.assets || []).filter(a => a.pageId === pageId)) {
      try {
        const rec = JSON.parse(await fs.readFile(path.join(this.assetsDir, link.assetId + '.json'), 'utf8'));
        out.push({ ...link, ...rec, assetId: link.assetId });
      } catch {}
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getAssetRecord(assetId) {
    try {
      const rec = JSON.parse(await fs.readFile(path.join(this.assetsDir, assetId + '.json'), 'utf8'));
      const link = (this.s.assets || []).find(a => a.assetId === assetId);
      if (!link || !this.s.pages.some(page => page.id === link.pageId)) return null;
      return { ...rec, ...link };
    } catch { return null; }
  }

  async getAuthorizedAsset(assetOrLinkId, unlockedIds) {
    const links = (this.s.assets || []).filter(link => link.id === assetOrLinkId || link.assetId === assetOrLinkId);
    const link = links.find(candidate => {
      const page = this.s.pages.find(item => item.id === candidate.pageId);
      return page && this.isNotebookAccessible(page.notebookId, unlockedIds);
    });
    if (!link) return null;
    try {
      const rec = JSON.parse(await fs.readFile(path.join(this.assetsDir, link.assetId + '.json'), 'utf8'));
      return { ...rec, ...link };
    } catch { return null; }
  }

  async getAssetData(assetId) {
    try { return await fs.readFile(path.join(this.assetsDir, assetId)); } catch { return null; }
  }

  async deleteAsset(id, unlockedIds) {
    const links = (this.s.assets || []).filter(a => a.id === id || a.assetId === id);
    if (links.length === 0) return false;
    if (unlockedIds) {
      for (const link of links) this.getPage(link.pageId, unlockedIds);
    }
    const assetId = links[0].assetId;
    const linkIds = new Set(links.map(l => l.id));
    this.s.assets = (this.s.assets || []).filter(a => !linkIds.has(a.id));
    const stillUsed = (this.s.assets || []).some(a => a.assetId === assetId);
    if (!stillUsed) {
      try { await fs.unlink(path.join(this.assetsDir, assetId)); } catch {}
      try { await fs.unlink(path.join(this.assetsDir, assetId + '.json')); } catch {}
    }
    this._scheduleSave();
    return true;
  }

  // ---------- complete backup / restore ----------

  async createBackupFiles() {
    await this.flush();
    const state = JSON.parse(JSON.stringify({ ...this.s, lockSessions: [] }));
    const manifest = {
      format: 'notebook-backup', version: 1, createdAt: isoNow(), state,
      assetRecords: [], revisions: [],
    };
    const files = [];
    for (const page of state.pages) {
      files.push({ name: `pages/${page.id}.md`, data: await this.readBody(page.id) });
      for (const revision of await this.listRevisions(page.id)) {
        const full = await this.getRevision(page.id, revision.id);
        const { markdown, ...record } = full;
        manifest.revisions.push(record);
        files.push({ name: `revisions/${page.id}/${revision.id}.md`, data: markdown });
      }
    }
    const assetIds = new Set(state.assets.map(link => link.assetId));
    for (const assetId of assetIds) {
      const record = await readOptionalJson(path.join(this.assetsDir, assetId + '.json'), 'asset record');
      const data = await fs.readFile(path.join(this.assetsDir, assetId));
      if (!record || record.id !== assetId || record.checksum !== assetId || sha256(data) !== assetId) {
        throw new Error(`asset ${assetId} failed backup integrity checks`);
      }
      manifest.assetRecords.push(record);
      files.push({ name: `assets/${assetId}`, data });
    }
    files.unshift({ name: 'manifest.json', data: JSON.stringify(manifest) });
    return files;
  }

  async restoreBackup(entries) {
    await this.flush();
    if (!this.isEmptyWorkspace()) {
      const err = new Error('backup restore requires an empty workspace');
      err.status = 409;
      err.extra = { code: 'workspace_not_empty' };
      throw err;
    }
    for (const dir of [this.pagesDir, this.revsDir, this.assetsDir]) {
      if ((await fs.readdir(dir)).length) {
        const err = new Error('backup restore requires empty storage directories');
        err.status = 409;
        err.extra = { code: 'workspace_not_empty' };
        throw err;
      }
    }
    const rawManifest = entries.get('manifest.json');
    if (!rawManifest) throw restoreError('backup manifest is missing');
    let manifest;
    try { manifest = JSON.parse(rawManifest.toString('utf8')); }
    catch { throw restoreError('backup manifest is invalid'); }
    validateBackupManifest(manifest, entries);

    const written = [];
    const createdDirs = new Set();
    const priorState = this.s;
    try {
      for (const page of manifest.state.pages) {
        const target = this.bodyPath(page.id);
        await atomicWrite(target, entries.get(`pages/${page.id}.md`));
        written.push(target);
      }
      for (const revision of manifest.revisions) {
        const dir = this.revDir(revision.pageId);
        await fs.mkdir(dir, { recursive: true });
        createdDirs.add(dir);
        const metaPath = path.join(dir, revision.id + '.json');
        const bodyPath = path.join(dir, revision.id + '.md');
        await atomicWrite(metaPath, JSON.stringify(revision));
        written.push(metaPath);
        await atomicWrite(bodyPath, entries.get(`revisions/${revision.pageId}/${revision.id}.md`));
        written.push(bodyPath);
      }
      for (const record of manifest.assetRecords) {
        const blobPath = path.join(this.assetsDir, record.id);
        const metaPath = path.join(this.assetsDir, record.id + '.json');
        await atomicWrite(blobPath, entries.get(`assets/${record.id}`));
        written.push(blobPath);
        await atomicWrite(metaPath, JSON.stringify(record));
        written.push(metaPath);
      }
      this.s = { ...manifest.state, lockSessions: [] };
      validateStateShape(this.s);
      this._titleIndex = null;
      this._linkDirty = true;
      this._scheduleSave();
      await this.flush();
    } catch (err) {
      this.s = priorState;
      // Restore the prior index before removing installed files. If rollback
      // persistence itself fails, retain those files so an index that may have
      // reached disk never points at deleted data.
      try {
        await atomicWrite(this.indexPath, JSON.stringify(priorState));
        await atomicWrite(this.metaPath, JSON.stringify(this.settings));
        this._dirty = false;
        this._saveError = null;
      } catch (rollbackError) {
        this._dirty = true;
        this._saveError = rollbackError;
        rollbackError.cause = err;
        throw rollbackError;
      }
      for (const filePath of written.reverse()) await fs.unlink(filePath).catch(() => {});
      for (const dir of [...createdDirs].reverse()) await fs.rmdir(dir).catch(() => {});
      throw err;
    }
    return {
      notebooks: this.s.notebooks.length,
      pages: this.s.pages.length,
      assets: this.s.assets.length,
      revisions: manifest.revisions.length,
    };
  }

  isEmptyWorkspace() {
    return ['notebooks', 'sections', 'pages', 'tags', 'pageTags', 'taskSteps', 'comments', 'readingPositions', 'assets', 'deletedNotebooks']
      .every(key => this.s[key].length === 0);
  }

  // ---------- reading position ----------

  getReadingPosition(pageId) {
    return this.s.readingPositions.find(r => r.pageId === pageId) || null;
  }

  setReadingPosition(pageId, { anchorOffset, viewportFraction, deviceId }) {
    let rec = this.s.readingPositions.find(r => r.pageId === pageId);
    if (!rec) {
      rec = { pageId, anchorOffset: 0, viewportFraction: 0, updatedAt: isoNow(), deviceId: 'web' };
      this.s.readingPositions.push(rec);
    }
    rec.anchorOffset = anchorOffset ?? rec.anchorOffset;
    rec.viewportFraction = viewportFraction ?? rec.viewportFraction;
    rec.deviceId = deviceId || 'web';
    rec.updatedAt = isoNow();
    this._scheduleSave();
    return rec;
  }

  // ---------- tasks / reminders ----------

  listTasks({ scope, includeCompleted } = {}, unlockedIds) {
    const lockedNbs = new Set(this.s.notebooks.filter(n => n.locked && !unlockedIds.has(n.id)).map(n => n.id));
    let pages = this.s.pages.filter(p => p.kind === 'task' && !p.deletedAt && !lockedNbs.has(p.notebookId));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (scope === 'today') {
      const tomorrow = new Date(today.getTime() + 86400000);
      pages = pages.filter(p => {
        if (!p.dueAt) return false;
        const d = new Date(p.dueAt);
        return d >= today && d < tomorrow;
      });
    } else if (scope === 'overdue') {
      pages = pages.filter(p => p.dueAt && !p.completedAt && new Date(p.dueAt) < today);
    } else if (scope === 'upcoming') {
      pages = pages.filter(p => p.dueAt && !p.completedAt && new Date(p.dueAt) >= today);
    } else if (scope === 'completed') {
      pages = pages.filter(p => p.completedAt);
    } else {
      pages = pages.filter(p => !p.completedAt || includeCompleted);
    }
    return pages
      .sort((a, b) => (a.dueAt || '9999').localeCompare(b.dueAt || '9999') || a.createdAt.localeCompare(b.createdAt))
      .map(p => ({ ...p, steps: this.s.taskSteps.filter(s => s.pageId === p.id && !s.checked).length }));
  }

  listReminders(unlockedIds, now = Date.now()) {
    const lockedNbs = new Set(this.s.notebooks.filter(n => n.locked && !unlockedIds.has(n.id)).map(n => n.id));
    const horizon = now + 30 * 86400000;
    return this.s.pages
      .filter(p => !p.deletedAt && !p.completedAt && p.reminderAt && !lockedNbs.has(p.notebookId))
      .map(p => {
        const projected = projectRecurrence(p.reminderAt, p.recurrenceRule, now);
        if (!projected) return null;
        return {
          pageId: p.id, title: p.title, notebookId: p.notebookId,
          reminderAt: projected, originalReminderAt: p.reminderAt,
          recurrenceRule: p.recurrenceRule || null,
          recurrenceOccurrence: p.recurrenceRule ? `${p.id}:${projected}` : null,
          dueAt: p.dueAt || null, completedAt: null,
        };
      })
      .filter(Boolean)
      .filter(r => {
        const t = new Date(r.reminderAt).getTime();
        return t >= now - 86400000 && t <= horizon;
      })
      .sort((a, b) => a.reminderAt.localeCompare(b.reminderAt));
  }

  // ---------- search ----------

  async search(q, unlockedIds) {
    const query = String(q || '').trim().toLowerCase();
    if (!query) return [];
    const terms = query.split(/\s+/).filter(Boolean);
    const lockedNbs = new Set(this.s.notebooks.filter(n => n.locked && !unlockedIds.has(n.id)).map(n => n.id));
    const out = [];
    for (const p of this.s.pages) {
      if (p.deletedAt) continue;
      if (lockedNbs.has(p.notebookId)) continue;
      const body = await this.readBody(p.id);
      const hay = (p.title + '\n' + (p.preview || '') + '\n' + body).toLowerCase();
      if (terms.every(t => hay.includes(t))) {
        out.push({ pageId: p.id, title: p.title, notebookId: p.notebookId, sectionId: p.sectionId, kind: p.kind, updatedAt: p.updatedAt, preview: p.preview, favorite: p.favorite });
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 200);
  }

  // ---------- stats ----------

  async stats() {
    const pages = this.s.pages.filter(p => !p.deletedAt);
    const lockedNbs = new Set(this.s.notebooks.filter(n => n.locked).map(n => n.id));
    let assetBytes = 0;
    let assets = 0;
    for (const a of (this.s.assets || [])) {
      const rec = await this.getAssetRecord(a.assetId);
      if (rec) { assets++; assetBytes += rec.byteSize || 0; }
    }
    return {
      notebooks: this.s.notebooks.filter(n => !n.deletedAt).length,
      sections: this.s.sections.filter(x => !x.deletedAt).length,
      pages: pages.length,
      pagesInTrash: this.s.pages.filter(p => p.deletedAt).length,
      tags: this.s.tags.filter(t => !t.deletedAt).length,
      tasksOpen: this.s.pages.filter(p => p.kind === 'task' && !p.deletedAt && !p.completedAt && !lockedNbs.has(p.notebookId)).length,
      assets, assetBytes,
      revisions: (await Promise.all(pages.map(p => this.listRevisions(p.id)))).reduce((n, r) => n + r.length, 0),
      serverName: this.settings.serverName,
      workspaceName: this.s.workspace.name,
      requireLogin: !!this.settings.requireLogin,
    };
  }

  // ---------- settings / login ----------

  updateSettings(patch) {
    for (const k of ['serverName', 'workspaceName', 'requireLogin']) {
      if (patch[k] !== undefined) this.settings[k] = patch[k];
    }
    if (patch.workspaceName !== undefined) {
      this.s.workspace.name = patch.workspaceName;
      this.s.workspace.updatedAt = isoNow();
      this._scheduleSave();
    }
    if (patch.newPassword) {
      const salt = sha256(uuid());
      this.settings.passwordSalt = salt;
      this.settings.passwordHash = hashPassword(patch.newPassword, salt);
      this.settings.requireLogin = true;
    }
    this._scheduleSave();
    return this.settings;
  }

  checkServerPassword(password) {
    if (!this.settings.passwordHash) return false;
    return hashPassword(String(password), this.settings.passwordSalt) === this.settings.passwordHash;
  }
}

async function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${uuid()}`;
  let handle;
  try {
    handle = await fs.open(tmp, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmp, filePath);
    const dirHandle = await fs.open(path.dirname(filePath), 'r');
    try { await dirHandle.sync(); }
    finally { await dirHandle.close(); }
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

async function readOptionalJson(filePath, label) {
  let raw;
  try { raw = await fs.readFile(filePath, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return undefined; throw err; }
  try { return JSON.parse(raw); }
  catch (cause) {
    const err = new Error(`${label} is corrupt; refusing to start`);
    err.cause = cause;
    throw err;
  }
}

function validateStateShape(state) {
  if (!state.workspace || typeof state.workspace !== 'object') throw new Error('notebook index has invalid workspace metadata');
  for (const key of ['notebooks', 'sections', 'pages', 'tags', 'pageTags', 'taskSteps', 'comments', 'readingPositions', 'assets', 'lockSessions', 'deletedNotebooks']) {
    if (!Array.isArray(state[key])) throw new Error(`notebook index has invalid ${key}`);
  }
}

function validatePersistedState(state) {
  if (!state || typeof state !== 'object' || !state.workspace || typeof state.workspace !== 'object') {
    throw new Error('notebook index has invalid workspace metadata; refusing to start');
  }
  for (const key of ['notebooks', 'sections', 'pages', 'tags', 'pageTags', 'taskSteps', 'comments', 'readingPositions']) {
    if (!Array.isArray(state[key])) throw new Error(`notebook index has invalid ${key}; refusing to start`);
  }
  for (const key of ['assets', 'lockSessions', 'deletedNotebooks']) {
    if (state[key] !== undefined && !Array.isArray(state[key])) throw new Error(`notebook index has invalid ${key}; refusing to start`);
  }
}

function restoreError(message) {
  const err = new Error(message);
  err.status = 400;
  err.extra = { code: 'invalid_backup' };
  return err;
}

function validateBackupManifest(manifest, entries) {
  if (!manifest || manifest.format !== 'notebook-backup' || manifest.version !== 1 || !manifest.state) {
    throw restoreError('unsupported backup format');
  }
  try { validateStateShape(manifest.state); }
  catch { throw restoreError('backup state is invalid'); }
  if (!Array.isArray(manifest.assetRecords) || !Array.isArray(manifest.revisions)) throw restoreError('backup file lists are invalid');
  const safeId = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value);
  const uniqueIds = (items, label) => {
    const ids = new Set();
    for (const item of items) {
      if (!item || !safeId(item.id) || ids.has(item.id)) throw restoreError(`backup has invalid ${label} ids`);
      ids.add(item.id);
    }
    return ids;
  };
  const notebookIds = uniqueIds(manifest.state.notebooks, 'notebook');
  const sectionIds = uniqueIds(manifest.state.sections, 'section');
  const pageIds = uniqueIds(manifest.state.pages, 'page');
  const tagIds = uniqueIds(manifest.state.tags, 'tag');
  const sectionById = new Map(manifest.state.sections.map(item => [item.id, item]));
  const pageById = new Map(manifest.state.pages.map(item => [item.id, item]));
  if (!safeId(manifest.state.workspace.id)) throw restoreError('backup has invalid workspace id');
  for (const notebook of manifest.state.notebooks) {
    if (notebook.workspaceId !== manifest.state.workspace.id) throw restoreError('backup has invalid notebook workspace relation');
    if (notebook.locked) {
      if (!/^[a-f0-9]{64}$/.test(notebook.lockSalt || '') || !/^[a-f0-9]{64}$/.test(notebook.lockHash || '')) {
        throw restoreError('backup has invalid locked notebook credentials');
      }
    } else {
      delete notebook.lockSalt;
      delete notebook.lockHash;
    }
  }
  for (const section of manifest.state.sections) {
    if (!notebookIds.has(section.notebookId) || (section.parentSectionId && !sectionIds.has(section.parentSectionId))) throw restoreError('backup has invalid section relations');
    if (section.parentSectionId) {
      const parent = sectionById.get(section.parentSectionId);
      if (parent.notebookId !== section.notebookId) throw restoreError('backup has cross-notebook section relations');
    }
  }
  for (const page of manifest.state.pages) {
    if (!notebookIds.has(page.notebookId) || (page.sectionId && !sectionIds.has(page.sectionId)) || (page.parentPageId && !pageIds.has(page.parentPageId))) {
      throw restoreError('backup has invalid page relations');
    }
    if (page.sectionId) {
      const section = sectionById.get(page.sectionId);
      if (section.notebookId !== page.notebookId) throw restoreError('backup has cross-notebook page/section relations');
    }
    if (page.parentPageId) {
      const parent = pageById.get(page.parentPageId);
      if (parent.notebookId !== page.notebookId) throw restoreError('backup has cross-notebook page relations');
    }
    if (!entries.has(`pages/${page.id}.md`)) throw restoreError(`backup body is missing for page ${page.id}`);
  }
  rejectParentCycles(manifest.state.sections, 'parentSectionId', 'section');
  rejectParentCycles(manifest.state.pages, 'parentPageId', 'page');
  for (const link of manifest.state.pageTags) if (!pageIds.has(link.pageId) || !tagIds.has(link.tagId)) throw restoreError('backup has invalid tag relations');
  for (const key of ['taskSteps', 'comments', 'readingPositions']) {
    for (const record of manifest.state[key]) if (!pageIds.has(record.pageId)) throw restoreError(`backup has invalid ${key} relations`);
  }
  const assetIds = uniqueIds(manifest.assetRecords, 'asset');
  for (const record of manifest.assetRecords) {
    if (!/^[a-f0-9]{64}$/.test(record.id) || record.checksum !== record.id) throw restoreError('backup has invalid asset checksum');
    const data = entries.get(`assets/${record.id}`);
    if (!data || sha256(data) !== record.id) throw restoreError(`backup asset ${record.id} failed integrity checks`);
  }
  const assetLinkIds = new Set();
  for (const link of manifest.state.assets) {
    if (!safeId(link.id) || assetLinkIds.has(link.id) || !pageIds.has(link.pageId) || !assetIds.has(link.assetId)) throw restoreError('backup has invalid asset relations');
    assetLinkIds.add(link.id);
  }
  const revisionIds = new Set();
  for (const revision of manifest.revisions) {
    if (!safeId(revision.id) || revisionIds.has(revision.id) || !pageIds.has(revision.pageId)) throw restoreError('backup has invalid revision relations');
    revisionIds.add(revision.id);
    if (!entries.has(`revisions/${revision.pageId}/${revision.id}.md`)) throw restoreError(`backup revision ${revision.id} is missing`);
  }
  manifest.state.lockSessions = [];
}

function placementError(message) {
  const error = new Error(message);
  error.status = 400;
  error.extra = { code: 'invalid_placement' };
  return error;
}

function validateParentPlacement(items, item, parentKey, label) {
  const byId = new Map(items.map(value => [value.id, value]));
  const seen = new Set([item.id]);
  let parentId = item[parentKey];
  while (parentId) {
    if (seen.has(parentId)) throw placementError(`cyclic ${label} relations are not allowed`);
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent || parent.notebookId !== item.notebookId) throw placementError(`parent ${label} does not belong to notebook`);
    parentId = parent[parentKey];
  }
}

function rejectParentCycles(items, parentKey, label) {
  const byId = new Map(items.map(item => [item.id, item]));
  for (const item of items) {
    const seen = new Set([item.id]);
    let current = item;
    while (current[parentKey]) {
      if (seen.has(current[parentKey])) throw restoreError(`backup has cyclic ${label} relations`);
      seen.add(current[parentKey]);
      current = byId.get(current[parentKey]);
      if (!current) break;
    }
  }
}

function sameValue(a, b) {
  if (a === b) return true;
  if ((a === undefined || a === null) && (b === undefined || b === null)) return true;
  if (Array.isArray(a) || Array.isArray(b) || (a && typeof a === 'object') || (b && typeof b === 'object')) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function projectRecurrence(reminderAt, rule, now) {
  const original = new Date(reminderAt);
  if (!Number.isFinite(original.getTime())) return null;
  if (!['daily', 'weekly', 'monthly'].includes(rule) || original.getTime() > now) return original.toISOString();
  const lowerBound = now - 86_400_000;
  if (rule === 'daily' || rule === 'weekly') {
    const period = rule === 'daily' ? 86_400_000 : 7 * 86_400_000;
    let ts = original.getTime() + Math.floor((now - original.getTime()) / period) * period;
    if (ts < lowerBound) ts += period;
    return new Date(ts).toISOString();
  }
  const day = original.getUTCDate();
  const occurrence = (year, month) => new Date(Date.UTC(
    year, month, Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate()),
    original.getUTCHours(), original.getUTCMinutes(), original.getUTCSeconds(), original.getUTCMilliseconds(),
  ));
  const current = new Date(now);
  const currentOccurrence = occurrence(current.getUTCFullYear(), current.getUTCMonth());
  const latest = currentOccurrence.getTime() <= now
    ? currentOccurrence
    : occurrence(current.getUTCFullYear(), current.getUTCMonth() - 1);
  if (latest.getTime() >= original.getTime() && latest.getTime() >= lowerBound) return latest.toISOString();
  const next = currentOccurrence.getTime() > now
    ? currentOccurrence
    : occurrence(current.getUTCFullYear(), current.getUTCMonth() + 1);
  return new Date(Math.max(original.getTime(), next.getTime())).toISOString();
}

function firstHeading(markdown) {
  const m = /^#\s+(.+)$/m.exec(markdown || '');
  return m ? m[1].trim() : null;
}

function makePreview(markdown) {
  const text = stripMarkdown(markdown || '').replace(/\s+/g, ' ');
  return text.slice(0, PREVIEW_LEN) + (text.length > PREVIEW_LEN ? '…' : '');
}

function guessKind(mimeType, filename) {
  const mt = String(mimeType || '');
  const fn = String(filename || '').toLowerCase();
  if (mt.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/.test(fn)) return 'image';
  if (mt.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac)$/.test(fn)) return 'audio';
  if (mt.startsWith('video/') || /\.(mp4|webm|mov|mkv)$/.test(fn)) return 'video';
  return 'file';
}
