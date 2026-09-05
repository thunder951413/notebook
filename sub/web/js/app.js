// Notebook web app — main controller.
import { api } from './api.js';
import { renderMarkdown } from './markdown.js';
import { diffLines, renderDiffRows } from './diff.js';
import { renderGraph } from './graph.js';
import { recordDiagnostic,installDiagnostics,downloadBrowserDiagnostics } from './diagnostics.js';
import { createSaveQueue } from './save-queue.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => window.markdownEscape(s);
const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const fmtFull = (iso) => iso ? new Date(iso).toLocaleString() : '';
const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
};
const fromLocalInput = (v) => v ? new Date(v).toISOString() : null;

function readStoredReminders() {try {const value=JSON.parse(sessionStorage.getItem('nb-reminders-shown') || '[]');return Array.isArray(value)?value:[];}catch{return [];}}

const state = {
  workspace: null,
  settings: null,
  notebooks: [],
  tags: [],
  stats: null,
  pages: new Map(),
  currentPageId: null,
  currentPage: null,
  currentBody: '',
  lastSavedBody: '',
  editorMode: (localStorage.getItem('nb-mode') || 'split'),
  dirty: false,
  saving: false,
  saveTimer: null,
  searchTimer: null,
  reminderShown: new Set(readStoredReminders()),
  inspectorPageId: null,
};

let routeVersion = 0;
const isNarrow = () => window.innerWidth <= 760;
const saves = createSaveQueue({
  save: (id, patch) => api.put('/api/pages/' + id, patch), storage: localStorage,
  onChange: (id, entry) => {
    if (entry.saved) state.pages.set(id, entry.saved);
    if (state.currentPageId !== id) return;
    state.dirty = !!entry.pending;
    state.saving = !!entry.promise;
    const status = $('save-status');
    status.className = 'save-status';
    if (entry.error) {
      status.textContent = entry.storageError ? '保存与草稿均失败，请勿关闭页面' : entry.error.status === 409 ? '有版本冲突，草稿已保留' : '未保存到服务器，草稿已保留';
      status.classList.add('error');
      $('btn-save-retry').classList.remove('hidden');
    } else if (entry.pending) {
      status.textContent = entry.storageError ? '浏览器草稿保存失败，请勿关闭页面' : entry.promise ? '保存中…' : '未保存…';
      status.classList.add(entry.storageError ? 'error' : 'saving');
    } else if (entry.saved) {
      status.textContent = '已保存';
      $('btn-save-retry').classList.add('hidden');
      if ($('page-title-input').value === entry.savedSnapshot.title) $('page-title-input').value = entry.saved.title;
      state.currentPage = { ...state.currentPage, ...entry.saved };
      state.lastSavedBody = entry.savedSnapshot.markdown;
      renderSidebar();
    }
  },
});

installDiagnostics();

// ---------- routing ----------

function parseRoute() {
  const h = location.hash.slice(1) || '/';
  const parts = h.split('/').filter(Boolean);
  const kind = parts[0] || '';
  if (kind === 'page' && parts[1]) return { view: 'page', pageId: parts[1] };
  if (kind === 'nb' && parts[1]) return { view: 'notebook', notebookId: parts[1] };
  if (kind === 'sec' && parts[1]) return { view: 'section', sectionId: parts[1] };
  if (kind === 'tag' && parts[1]) return { view: 'tag', tagId: parts[1] };
  if (kind === 'search') return { view: 'search', q: decodeURIComponent(parts.slice(1).join('/')) };
  if (['favorites', 'tasks', 'trash', 'reminders', 'graph', 'settings'].includes(kind)) return { view: kind };
  return { view: 'home' };
}

function navigate(route) {
  if (typeof route === 'string') location.hash = route;
  else if (route.view === 'page') location.hash = '#/page/' + route.pageId;
  else if (route.view === 'notebook') location.hash = '#/nb/' + route.notebookId;
  else if (route.view === 'section') location.hash = '#/sec/' + route.sectionId;
  else if (route.view === 'tag') location.hash = '#/tag/' + route.tagId;
  else location.hash = '#/' + route.view;
}

// ---------- toasts ----------

function toast(msg, type) {
  const root = $('toast-root');
  const el = document.createElement('div');
  el.className = 'toast ' + (type || 'info');
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3600);
}

// ---------- boot ----------

async function boot() {
  applyTheme();
  bindGlobalEvents();
  bindLogin();
  window.addEventListener('hashchange', onRoute);
  try {
    await loadState();
  } catch (err) {
    // server unreachable or login required — leave screens as-is
    if (err.status !== 401) showConnectionError();
    return;
  }
  { // A successful /api/state already proves this session is authenticated.
    $('login-screen').classList.add('hidden');
    $('app').classList.remove('hidden');
  }
  void onRoute();
  startReminderPoll();
}

function applyTheme() {
  const t = localStorage.getItem('nb-theme') || 'light';
  document.documentElement.dataset.theme = t;
  $('theme-toggle') && ($('theme-toggle').textContent = t === 'dark' ? '☀️' : '🌙');
}

function bindGlobalEvents() {
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 's') { e.preventDefault(); saveNow(); }
    if (mod && e.key === 'b' && editorFocused()) { e.preventDefault(); toolbarCmd('bold'); }
    if (mod && e.key === 'i' && editorFocused()) { e.preventDefault(); toolbarCmd('italic'); }
    if (e.key === '/' && !e.target.closest('input,textarea,select,[contenteditable=true]') && !isModalOpen()) { e.preventDefault(); $('search-input').focus(); }
    if (e.key === 'Escape') {
      closeModals();
      closeSidePanels();
      $('search-results').classList.add('hidden');
      document.activeElement && document.activeElement.blur();
    }
  });
  document.addEventListener('click', (e) => {
    const wiki = e.target.closest('a.wiki');
    if (wiki) {
      e.preventDefault();
      const target = wiki.dataset.wiki;
      const page = findPageByTitle(target);
      if (page) navigate({ view: 'page', pageId: page.id });
      else toast('未找到页面: ' + target, 'warn');
      return;
    }
    const task = e.target.closest('input[data-task]');
    if (task) { toggleTaskInPreview(task); return; }
    const img = e.target.closest('img[data-lightbox]');
    if (img) { openLightbox(img.src, img.alt); return; }
  });
  $('search-input').addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    const q = $('search-input').value.trim();
    if (!q) { $('search-results').classList.add('hidden'); return; }
    state.searchTimer = setTimeout(() => doSearch(q), 250);
  });
  $('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = $('search-input').value.trim();
      if (q) { $('search-results').classList.add('hidden'); navigate({ view: 'search', q }); }
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) $('search-results').classList.add('hidden');
  });
}

function isModalOpen() {
  return !!$('modal-root').querySelector('.modal');
}

function editorFocused() {
  return document.activeElement && (document.activeElement.id === 'editor' || document.activeElement.id === 'page-title-input');
}

function findPageByTitle(title) {
  const t = String(title).trim().toLowerCase();
  for (const p of state.pages.values()) {
    if (p.title && p.title.toLowerCase() === t && !p.deletedAt) return p;
  }
  return null;
}

// ---------- login ----------

function bindLogin() {
  window.addEventListener('nb:login-required', () => {
    $('app').classList.add('hidden');
    $('login-screen').classList.remove('hidden');
    $('login-error').classList.add('hidden');
  });
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/login', { password: $('login-password').value });
      $('login-password').value = '';
      $('login-screen').classList.add('hidden');
      $('app').classList.remove('hidden');
      await loadState();
      await onRoute();
      startReminderPoll();
    } catch (err) {
      $('login-error').textContent = err.message || '登录失败';
      $('login-error').classList.remove('hidden');
    }
  });
}

// ---------- state loading ----------

async function loadState() {
  const data = await api.get('/api/state');
  state.workspace = data.workspace;
  state.settings = data.settings;
  state.notebooks = data.notebooks;
  state.tags = data.tags;
  state.stats = data.stats;
  $('workspace-name').textContent = data.workspace.name;
  $('login-title').textContent = data.settings.serverName || 'Notebook Server';
  document.title = (data.settings.serverName || 'Notebook') + ' — ' + data.workspace.name;
  await loadAllPages();
  renderSidebar();
  renderTagsPanel();
}

async function loadAllPages() {
  // load pages for unlocked notebooks (locked ones return placeholders)
  const res = await api.get('/api/pages', { includeLocked: 1 });
  state.pages = new Map(res.items.map(p => [p.id, p]));
}

// ---------- sidebar ----------

function renderSidebar() {
  const root = $('notebooks');
  root.innerHTML = '';
  for (const nb of state.notebooks) {
    const div = document.createElement('div');
    div.className = 'nb-block';
    const header = document.createElement('div');
    header.className = 'nb-header';
    header.innerHTML =
      '<span class="nb-emoji">' + esc(nb.emoji || '📓') + '</span>' +
      '<span class="nb-name">' + esc(nb.name) + '</span>' +
      (nb.locked && !nb.unlocked ? '<span class="nb-lock" title="已锁定">🔒</span>' : '') +
      '<span class="nb-count">' + nb.pageCount + '</span>' +
      '<span class="nb-actions">' +
      '<button class="mini-btn" data-nb-add-page title="新建笔记">＋</button>' +
      '<button class="mini-btn" data-nb-add-sec title="新建分区">🗂</button>' +
      '<button class="mini-btn" data-nb-menu title="更多">⋯</button>' +
      '</span>';
    header.dataset.nbId = nb.id;
    header.querySelector('[data-nb-add-page]').addEventListener('click', (e) => { e.stopPropagation(); newPage(nb.id); });
    header.querySelector('[data-nb-add-sec]').addEventListener('click', (e) => { e.stopPropagation(); newSection(nb.id); });
    header.querySelector('[data-nb-menu]').addEventListener('click', (e) => { e.stopPropagation(); notebookMenu(nb); });
    header.addEventListener('click', () => {
      if (nb.locked && !nb.unlocked) { unlockDialog(nb); return; }
      navigate({ view: 'notebook', notebookId: nb.id });
    });
    div.appendChild(header);

    if (!nb.locked || nb.unlocked) {
      const body = document.createElement('div');
      body.className = 'nb-body';
      // sections
      const secs = nb.sections || [];
      for (const sec of secs) {
        const secDiv = document.createElement('div');
        secDiv.className = 'sec-row';
        secDiv.innerHTML =
          '<span class="sec-caret">▾</span><span class="sec-name">' + esc(sec.name) + '</span>' +
          '<span class="nb-count">' + sec.pageCount + '</span>' +
          '<span class="sec-actions"><button class="mini-btn" data-sec-add title="新建笔记">＋</button>' +
          '<button class="mini-btn" data-sec-menu title="分区菜单">⋯</button></span>';
        secDiv.addEventListener('click', (e) => {
          if (e.target.closest('[data-sec-add]')) { e.stopPropagation(); newPage(nb.id, sec.id); return; }
          if (e.target.closest('[data-sec-menu]')) { e.stopPropagation(); sectionMenu(nb, sec); return; }
          navigate({ view: 'section', sectionId: sec.id });
        });
        body.appendChild(secDiv);
        // pages of section
        const secPages = [...state.pages.values()].filter(p => p.sectionId === sec.id && !p.deletedAt);
        const byParent = (pid) => secPages.filter(p => p.parentPageId === pid);
        const renderPage = (p, depth) => {
          const row = document.createElement('div');
          row.className = 'page-row' + (state.currentPageId === p.id ? ' active' : '');
          row.style.paddingLeft = (12 + depth * 14) + 'px';
          row.innerHTML =
            '<span class="page-ico">' + esc(p.icon || (p.kind === 'task' ? '✅' : '📄')) + '</span>' +
            '<span class="page-title">' + esc(p.title || '无标题') + '</span>' +
            (p.favorite ? '<span class="fav-mark">★</span>' : '') +
            (p.reminderAt ? '<span class="rem-mark">🔔</span>' : '');
          row.addEventListener('click', () => navigate({ view: 'page', pageId: p.id }));
          body.appendChild(row);
          for (const child of byParent(p.id)) renderPage(child, depth + 1);
        };
        for (const p of secPages.filter(p => !p.parentPageId)) renderPage(p, 0);
      }
      // root pages (no section)
      const rootPages = [...state.pages.values()].filter(p => p.notebookId === nb.id && !p.sectionId && !p.deletedAt);
      const byParentRoot = (pid) => rootPages.filter(p => p.parentPageId === pid);
      const renderRootPage = (p, depth) => {
        const row = document.createElement('div');
        row.className = 'page-row' + (state.currentPageId === p.id ? ' active' : '');
        row.style.paddingLeft = (12 + depth * 14) + 'px';
        row.innerHTML =
          '<span class="page-ico">' + esc(p.icon || (p.kind === 'task' ? '✅' : '📄')) + '</span>' +
          '<span class="page-title">' + esc(p.title || '无标题') + '</span>' +
          (p.favorite ? '<span class="fav-mark">★</span>' : '');
        row.addEventListener('click', () => navigate({ view: 'page', pageId: p.id }));
        body.appendChild(row);
        for (const child of byParentRoot(p.id)) renderRootPage(child, depth + 1);
      };
      for (const p of rootPages.filter(p => !p.parentPageId)) renderRootPage(p, 0);
      div.appendChild(body);
    } else {
      const lockedRow = document.createElement('div');
      lockedRow.className = 'nb-locked-row';
      lockedRow.textContent = '🔒 内容已锁定，点击解锁';
      lockedRow.addEventListener('click', () => unlockDialog(nb));
      div.appendChild(lockedRow);
    }
    root.appendChild(div);
  }
}

function renderTagsPanel() {
  const list = $('tags-list');
  list.innerHTML = '';
  const counts = new Map();
  const pageTagRes = [...state.pages.values()];
  // counts computed from tag filter view requests would be heavy; show simple list
  for (const tag of state.tags) {
    const a = document.createElement('a');
    a.className = 'tag-link';
    a.href = '#/tag/' + tag.id;
    a.innerHTML = '<span class="tag-dot" style="background:' + esc(tag.color || '#888') + '"></span>' + esc(tag.name);
    list.appendChild(a);
  }
  if (!state.tags.length) {
    const empty = document.createElement('div');
    empty.className = 'muted small';
    empty.textContent = '暂无标签';
    list.appendChild(empty);
  }
}

function notebookMenu(nb) {
  const items = [];
  if (nb.locked && nb.unlocked) items.push({ label: '🔒 重新锁定', fn: () => relockNotebook(nb) });
  if (!nb.locked) items.push({ label: '🔐 设置访问密码并锁定', fn: () => lockNotebook(nb) });
  items.push({ label: '✏️ 重命名', fn: () => renameNotebook(nb) });
  items.push({ label: '📥 导入 Markdown/ZIP', fn: () => importDialog(nb) });
  items.push({ label: '🗑 删除笔记本', fn: () => deleteNotebook(nb), danger: true });
  showMenu(nb.emoji + ' ' + nb.name, items);
}

function sectionMenu(nb, sec) {
  showMenu('分区: ' + sec.name, [
    { label: '✏️ 重命名', fn: () => renameSection(nb, sec) },
    { label: '🗑 删除分区', fn: () => deleteSection(sec), danger: true },
  ]);
}

async function newSection(notebookId) {
  const name = prompt('新分区名称:', '');
  if (name === null || !name.trim()) return;
  try {
    await api.post('/api/sections', { notebookId, name: name.trim() });
    await loadState();
  } catch (err) { toast(err.message, 'error'); }
}

async function renameSection(nb, sec) {
  const name = prompt('重命名分区:', sec.name);
  if (name === null || !name.trim()) return;
  try {
    await api.patch('/api/sections/' + sec.id, { name: name.trim() });
    await loadState();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteSection(sec) {
  if (!confirm('删除分区及其所有页面（可稍后从回收站恢复）？')) return;
  try {
    await api.del('/api/sections/' + sec.id);
    await loadState();
    toast('分区已删除');
  } catch (err) { toast(err.message, 'error'); }
}

async function renameNotebook(nb) {
  const name = prompt('重命名笔记本:', nb.name);
  if (name === null || !name.trim()) return;
  try {
    await api.patch('/api/notebooks/' + nb.id, { name: name.trim() });
    await loadState();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteNotebook(nb) {
  if (!confirm('删除笔记本「' + nb.name + '」？其中的页面将移入回收站。')) return;
  try {
    await api.del('/api/notebooks/' + nb.id);
    await loadState();
    if (state.currentPageId) {
      const cur = state.pages.get(state.currentPageId);
      if (cur && cur.notebookId === nb.id) navigate({ view: 'home' });
    }
    toast('笔记本已删除');
  } catch (err) { toast(err.message, 'error'); }
}

async function lockNotebook(nb) {
  const pw = prompt('设置访问密码（至少 4 位）:\n锁定后需要密码才能查看内容');
  if (pw === null) return;
  if (pw.length < 4) { toast('密码至少 4 位', 'warn'); return; }
  const pw2 = prompt('再次输入密码确认:');
  if (pw2 !== pw) { toast('两次输入不一致', 'warn'); return; }
  try {
    if (!await flushAllSaves()) return;
    await api.post('/api/notebooks/' + nb.id + '/lock', { password: pw });
    await loadState();
    if (state.currentPage?.notebookId === nb.id) {navigate('#/');await onRoute();}
    toast('笔记本已锁定');
  } catch (err) { toast(err.message, 'error'); }
}

function unlockDialog(nb) {
  openModal(
    '解锁笔记本',
    '<p class="muted">' + esc(nb.emoji || '📓') + ' ' + esc(nb.name) + ' 已锁定，请输入访问密码：</p>' +
    '<input type="password" id="unlock-pw" class="modal-input" placeholder="访问密码" autocomplete="off">' +
    '<p id="unlock-err" class="error hidden"></p>',
    [
      { label: '取消', cls: 'btn' },
      { label: '解锁', cls: 'btn primary', id: 'unlock-ok' },
    ],
    (modal) => {
      $('unlock-ok').addEventListener('click', async () => {
        const pw = $('unlock-pw').value;
        try {
          await api.post('/api/notebooks/' + nb.id + '/unlock', { password: pw });
          closeModals();
          await loadState();
          toast('已解锁');
        } catch (err) {
          $('unlock-err').textContent = err.message;
          $('unlock-err').classList.remove('hidden');
        }
      });
      $('unlock-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('unlock-ok').click(); });
      $('unlock-pw').focus();
    }
  );
}

async function relockNotebook(nb) {
  try {
    if (!await flushAllSaves()) return;
    await api.post('/api/notebooks/' + nb.id + '/relock');
    if (state.currentPage) {
      const cur = state.pages.get(state.currentPage.id);
      if (cur && cur.notebookId === nb.id) navigate({ view: 'home' });
    }
    await loadState();
    toast('已重新锁定');
  } catch (err) { toast(err.message, 'error'); }
}

async function importDialog(nb) {
  const input = $('import-file-input');
  input.onchange = async () => {
    const files = [...input.files];
    if (!files.length) return;
    try {
      const res = await api.importFiles(nb.id, files);
      toast('已导入 ' + res.created + ' 个页面');
      await loadState();
    } catch (err) { toast(err.message, 'error'); }
    input.value = '';
  };
  input.click();
}

// ---------- modals / menus ----------

function openModal(title, bodyHtml, buttons, onReady) {
  const root = $('modal-root');
  root.innerHTML =
    '<div class="modal-overlay"><div class="modal" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
    '<div class="modal-header"><h3>' + esc(title) + '</h3><button class="icon-btn" data-close>✕</button></div>' +
    '<div class="modal-body">' + bodyHtml + '</div>' +
    '<div class="modal-footer">' + (buttons || []).map((b,i) => '<button class="' + b.cls + '" id="' + esc(b.id || '') + '" data-btn="' + esc(b.id || 'action-' + i) + '">' + esc(b.label) + '</button>').join('') + '</div>' +
    '</div></div>';
  root.querySelector('[data-close]').addEventListener('click', closeModals);
  root.querySelector('.modal-overlay').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) closeModals(); });
  (buttons || []).forEach((b,i) => {
    const el = root.querySelector('[data-btn="' + (b.id || 'action-' + i) + '"]');
    if (el) el.addEventListener('click', b.onClick || (() => {if (!b.id) closeModals();}));
  });
  onReady && onReady(root);
}

function closeModals() {
  $('modal-root').innerHTML = '';
  $('menu-root') && ($('menu-root').innerHTML = '');
}

function showMenu(title, items) {
  let root = $('menu-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'menu-root';
    document.body.appendChild(root);
  }
  root.innerHTML =
    '<div class="menu-overlay"><div class="menu-card">' +
    '<div class="menu-title">' + esc(title) + '</div>' +
    items.map((it, i) => '<button class="menu-item' + (it.danger ? ' danger' : '') + '" data-i="' + i + '">' + esc(it.label) + '</button>').join('') +
    '</div></div>';
  root.querySelector('.menu-overlay').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) root.innerHTML = ''; });
  items.forEach((it, i) => {
    root.querySelector('[data-i="' + i + '"]').addEventListener('click', () => { root.innerHTML = ''; it.fn(); });
  });
}

function openLightbox(src, alt) {
  const root = $('modal-root');
  root.innerHTML = '<div class="lightbox" id="lightbox"><img src="' + esc(src) + '" alt="' + esc(alt) + '"></div>';
  $('lightbox').addEventListener('click', () => { root.innerHTML = ''; });
}
// ---------- tasks view ----------

async function showTasks(scope) {
  $('tasks-view').classList.remove('hidden');
  document.querySelectorAll('.task-filter').forEach(b => b.classList.toggle('active', b.dataset.scope === scope));
  const res = await api.get('/api/tasks', { scope });
  const list = $('tasks-list');
  list.innerHTML = '';
  if (!res.items.length) {
    list.innerHTML = '<div class="empty-state">✅ 没有任务</div>';
    return;
  }
  for (const t of res.items) {
    const card = document.createElement('div');
    card.className = 'page-card';
    const nb = state.notebooks.find(n => n.id === t.notebookId);
    card.innerHTML =
      '<div class="page-card-icon">✅</div>' +
      '<div class="page-card-main">' +
      '<div class="page-card-title">' + esc(t.title) +
      (t.important ? ' <span class="hot-chip">🔥</span>' : '') +
      (t.completedAt ? ' <span class="done-chip">已完成</span>' : '') +
      '</div>' +
      '<div class="page-card-meta">' +
      '<span>' + esc(nb ? nb.emoji + ' ' + nb.name : '') + '</span>' +
      (t.dueAt ? '<span class="due-chip' + (t.dueAt && !t.completedAt && new Date(t.dueAt) < new Date() ? ' overdue' : '') + '">⏰ ' + fmtFull(t.dueAt) + '</span>' : '') +
      (t.steps ? '<span>' + t.steps + ' 个未完成步骤</span>' : '') +
      '</div></div>' +
      '<button class="btn small task-done" data-tdone="' + t.id + '">' + (t.completedAt ? '恢复' : '完成') + '</button>';
    card.querySelector('.page-card-main').addEventListener('click', () => navigate({ view: 'page', pageId: t.id }));
    card.querySelector('[data-tdone]').addEventListener('click', async (e) => {
      e.stopPropagation();
      await api.put('/api/pages/' + t.id, { completedAt: t.completedAt ? null : new Date().toISOString() });
      await loadState();
      showTasks(scope);
    });
    list.appendChild(card);
  }
}

// ---------- trash ----------

async function showTrash() {
  $('list-view').classList.remove('hidden');
  $('list-title').textContent = '🗑 回收站';
  $('btn-new-page').style.display = 'none';
  $('btn-import').style.display = 'none';
  $('btn-export-all').style.display = 'none';
  const res = await api.get('/api/trash');
  const list = $('page-list');
  list.innerHTML = '';
  if (!res.items.length) {
    list.innerHTML = '<div class="empty-state">🗑 回收站是空的</div>';
    return;
  }
  for (const p of res.items) {
    if (p.hidden) {
      const row = document.createElement('div');
      row.className = 'page-card muted';
      row.innerHTML = '<div class="page-card-main"><div class="page-card-title">🔒 锁定笔记本中的页面</div><div class="page-card-meta"><span>' + fmtDate(p.deletedAt) + '</span></div></div>';
      list.appendChild(row);
      continue;
    }
    const card = document.createElement('div');
    card.className = 'page-card';
    card.innerHTML =
      '<div class="page-card-icon">' + esc(p.icon || '📄') + '</div>' +
      '<div class="page-card-main">' +
      '<div class="page-card-title">' + esc(p.title || '无标题') + '</div>' +
      '<div class="page-card-meta"><span>' + esc(p.notebookName || '') + '</span><span>删除于 ' + fmtFull(p.deletedAt) + '</span></div></div>' +
      '<button class="btn small" data-restore="' + p.id + '">恢复</button> ' +
      '<button class="btn small danger" data-purge="' + p.id + '">彻底删除</button>';
    card.querySelector('[data-restore]').addEventListener('click', async (e) => {
      e.stopPropagation();
      await api.post('/api/pages/' + p.id + '/restore');
      await loadState();
      showTrash();
    });
    card.querySelector('[data-purge]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('彻底删除「' + p.title + '」？此操作不可恢复！')) return;
      await api.post('/api/pages/' + p.id + '/purge');
      await loadState();
      showTrash();
    });
    list.appendChild(card);
  }
}

// ---------- reminders ----------

async function showReminders() {
  $('list-view').classList.remove('hidden');
  $('list-title').textContent = '🔔 提醒';
  $('btn-new-page').style.display = 'none';
  $('btn-import').style.display = 'none';
  $('btn-export-all').style.display = 'none';
  const res = await api.get('/api/reminders');
  const list = $('page-list');
  list.innerHTML = '';
  if (!res.items.length) {
    list.innerHTML = '<div class="empty-state">🔔 没有即将到来的提醒<br><span class="muted">在笔记的「提醒」字段设置时间</span></div>';
    return;
  }
  for (const r of res.items) {
    const card = document.createElement('div');
    card.className = 'page-card';
    const nb = state.notebooks.find(n => n.id === r.notebookId);
    const due = new Date(r.reminderAt);
    const past = due < new Date();
    card.innerHTML =
      '<div class="page-card-icon">🔔</div>' +
      '<div class="page-card-main">' +
      '<div class="page-card-title">' + esc(r.title) + (r.completedAt ? ' <span class="done-chip">已完成</span>' : '') + '</div>' +
      '<div class="page-card-meta"><span>' + esc(nb ? nb.emoji + ' ' + nb.name : '') + '</span>' +
      '<span class="' + (past ? 'overdue' : '') + '">' + fmtFull(r.reminderAt) + (r.recurrenceRule ? ' (重复: ' + esc(r.recurrenceRule) + ')' : '') + '</span></div></div>';
    card.addEventListener('click', () => navigate({ view: 'page', pageId: r.pageId }));
    list.appendChild(card);
  }
}

function startReminderPoll() {
  if (state.reminderTimer) clearInterval(state.reminderTimer);
  state.reminderTimer = setInterval(checkReminders, 60000);
  checkReminders();
}

async function checkReminders() {
  try {
    const res = await api.get('/api/reminders');
    const now = Date.now();
    const due = res.items.filter(r => {
      const t = new Date(r.reminderAt).getTime();
      return t <= now && t > now - 86400000 && !r.completedAt;
    });
    for (const r of due) {
      const key = r.pageId + '@' + r.reminderAt;
      if (state.reminderShown.has(key)) continue;
      state.reminderShown.add(key);
      sessionStorage.setItem('nb-reminders-shown', JSON.stringify([...state.reminderShown]));
      toast('🔔 提醒: ' + r.title, 'remind');
      if ('Notification' in window && window.Notification.permission === 'granted') {
        try {const notice=new window.Notification('笔记提醒', {body:r.title,tag:key});notice.onclick=()=>{window.focus();navigate({view:'page',pageId:r.pageId});notice.close();};}catch{/* Some mobile browsers only support service-worker notifications. */}
      }
    }
  } catch {}
}

// ---------- graph ----------

async function showGraph() {
  $('graph-view').classList.remove('hidden');
  const svg = $('graph-svg');
  const nodes = [...state.pages.values()].filter(p => !p.deletedAt && !p.locked).map(p => ({ id: p.id, title: p.title || '无标题', icon: p.icon, kind: p.kind, notebookId: p.notebookId }));
  const links = [];
  // fetch bodies to compute [[links]]
  for (const p of nodes) {
    try {
      const page = await api.get('/api/pages/' + p.id);
      for (const l of (page.links || [])) links.push({ source: p.id, target: l.targetPageId });
    } catch {}
  }
  const showLinks = $('graph-show-links').checked;
  renderGraph(svg, nodes, showLinks ? links : [], {
    onSelect: (id) => navigate({ view: 'page', pageId: id }),
  });
}

// ---------- settings ----------

function showSettings() {
  openModal(
    '⚙️ 服务器设置',
    '<div class="settings-grid">' +
    '<label>服务器名称<input id="set-name" class="modal-input" value="' + esc(state.settings ? state.settings.serverName : '') + '"></label>' +
    '<label>工作区名称<input id="set-workspace" class="modal-input" value="' + esc(state.workspace ? state.workspace.name : '') + '"></label>' +
    '<label>新密码（留空不修改）<input id="set-password" class="modal-input" type="password" placeholder="设置/修改服务器登录密码"></label>' +
    '<div class="muted small">设置密码后，所有访问者访问此服务器都需要登录。</div>' +
    '</div>' +
    '<div class="settings-row"><button id="set-browser-logs" class="btn">导出浏览器诊断</button> <button id="set-server-logs" class="btn">导出服务器诊断</button></div><p class="muted small">出现问题后保留发生时间并导出两份日志。浏览器最多 256 KiB，服务器最多 2 MiB；不含笔记正文或密码。</p>' +
    '<div class="settings-row"><button id="set-backup" class="btn">下载完整备份</button> <button id="set-restore" class="btn">恢复完整备份</button></div>' +
    '<p class="muted small">完整备份包含正文、附件、历史、笔记本与标签；需先解锁全部私密笔记本。ZIP 未加密，请妥善保存。恢复仅允许空工作区。</p>' +
    '<div class="settings-row"><button id="set-notifications" class="btn">启用系统提醒</button></div><p class="muted small">每日、每周、每月提醒在网页打开时检查。关闭网页或系统暂停浏览器后，不能保证通知；手机不支持系统通知时仍显示页内提醒。</p>' +
    '<div class="settings-row"><button id="set-theme" class="btn">' + (localStorage.getItem('nb-theme') === 'dark' ? '☀️ 切换浅色' : '🌙 切换深色') + '</button></div>',
    [
      { label: '取消', cls: 'btn' },
      { label: '保存', cls: 'btn primary', id: 'set-save' },
    ],
    (modal) => {
      $('set-browser-logs').onclick=downloadBrowserDiagnostics;
      $('set-server-logs').onclick=()=>download('/api/diagnostics/export','notebook-server-diagnostics.jsonl');
      $('set-backup').onclick = async () => {if (await flushAllSaves()) {try {await download('/api/backup', 'notebook-backup.zip');}catch(error){toast(error.message,'error');}}};
      $('set-restore').onclick = () => {
        const input=$('backup-file-input');
        input.onchange=async()=>{const file=input.files[0];input.value='';if (!file)return;try {await api.restoreBackup(file);closeModals();await loadState();navigate('#/');await onRoute();toast('完整备份已恢复');}catch(error){toast(error.message,'error');}};input.click();
      };
      $('set-notifications').onclick = async () => {
        if (!('Notification' in window)) {toast('此浏览器不支持系统通知，仍会显示页内提醒','warn');return;}
        try {const permission=await window.Notification.requestPermission();toast(permission==='granted'?'已启用系统提醒（需保持网页打开）':'未获得通知权限，仍使用页内提醒');}catch{toast('此浏览器无法启用系统通知，仍使用页内提醒','warn');}
      };
      $('set-theme').addEventListener('click', () => {
        const t = localStorage.getItem('nb-theme') === 'dark' ? 'light' : 'dark';
        localStorage.setItem('nb-theme', t);
        applyTheme();
        showSettings();
      });
      $('set-save').addEventListener('click', async () => {
        try {
          const patch = {
            serverName: $('set-name').value.trim() || undefined,
            workspaceName: $('set-workspace').value.trim() || undefined,
          };
          if ($('set-password').value) patch.newPassword = $('set-password').value;
          await api.put('/api/settings', patch);
          closeModals();
          await loadState();
          toast('设置已保存');
        } catch (err) { toast(err.message, 'error'); }
      });
    }
  );
}

// ---------- history ----------

async function showHistory(page) {
  if (!await saveNow()) {toast('请先处理未保存内容','warn');return;}
  page = await api.get('/api/pages/' + page.id);
  const res = await api.get('/api/pages/' + page.id + '/revisions');
  openModal(
    '🕘 版本历史',
    '<div class="history-layout">' +
    '<div class="history-list" id="history-list"></div>' +
    '<div class="history-detail"><div id="history-diff" class="diff-view"></div></div>' +
    '</div>',
    [
      { label: '关闭', cls: 'btn' },
      { label: '创建手动版本', cls: 'btn', id: 'hist-manual' },
    ],
    (modal) => {
      const listEl = $('history-list');
      listEl.innerHTML = '';
      if (!res.items.length) listEl.innerHTML = '<div class="muted">暂无历史版本</div>';
      const reasonText = { autosave: '自动保存', manual: '手动', restore: '恢复', import: '导入' };
      res.items.forEach((rev, i) => {
        const item = document.createElement('div');
        item.className = 'hist-item' + (i === 0 ? ' active' : '');
        item.innerHTML = '<b>' + fmtFull(rev.createdAt) + '</b><span class="muted small">' + (reasonText[rev.reason] || rev.reason) + '</span>';
        item.addEventListener('click', async () => {
          document.querySelectorAll('.hist-item').forEach(x => x.classList.remove('active'));
          item.classList.add('active');
          const r = await api.get('/api/pages/' + page.id + '/revisions/' + rev.id);
          const diff = diffLines(page.markdown || '', r.markdown || '');
          $('history-diff').innerHTML = renderDiffRows(diff.rows);
          $('hist-restore') && ($('hist-restore').dataset.rev = rev.id);
          const restoreBtn = $('hist-restore');
          if (restoreBtn) { restoreBtn.style.display = 'inline-block'; restoreBtn.dataset.rev = rev.id; }
        });
        listEl.appendChild(item);
      });
      if (!modal.querySelector('#hist-restore')) {
        const footer = modal.querySelector('.modal-footer');
        const btn = document.createElement('button');
        btn.className = 'btn primary';
        btn.id = 'hist-restore';
        btn.textContent = '恢复此版本';
        btn.style.display = 'none';
        footer.appendChild(btn);
        btn.addEventListener('click', async () => {
          if (!confirm('恢复到此版本？当前内容会覆盖（仍可在历史中找到）。')) return;
          await api.post('/api/pages/' + page.id + '/revisions/' + btn.dataset.rev + '/restore');
          closeModals();
          await openPage(page.id);
          toast('已恢复');
        });
      }
      $('hist-manual').addEventListener('click', async () => {
        await api.post('/api/pages/' + page.id + '/revisions');
        closeModals();
        await openPage(page.id);
        toast('已创建手动版本');
      });
    }
  );
}

// ---------- page actions ----------

async function newPage(notebookId, sectionId, kind = 'document') {
  const nb = state.notebooks.find(n => n.id === notebookId);
  if (!nb) return;
  if (nb.locked && !nb.unlocked) { unlockDialog(nb); return; }
  try {
    const page = await api.post('/api/pages', { notebookId, sectionId, kind, markdown: kind === 'task' ? '' : '# 新笔记\n' });
    await loadState();
    navigate({ view: 'page', pageId: page.id });
  } catch (err) { toast(err.message, 'error'); }
}

async function newPageDialog() {
  if (!state.notebooks.length) {
    const name = prompt('还没有笔记本，先创建第一个：', '我的笔记本');
    if (!name) return;
    const nb = await api.post('/api/notebooks', { name: name.trim(), emoji: '📓' });
    await loadState();
    newPage(nb.id);
    return;
  }
  const options = state.notebooks.filter(n => !n.locked || n.unlocked).map(n => '<option value="' + n.id + '">' + esc(n.emoji + ' ' + n.name) + '</option>').join('');
  openModal(
    '新建笔记',
    '<select id="np-nb" class="modal-input">' + options + '</select>' +
    '<p><label class="muted"><input type="checkbox" id="np-kind"> 创建为任务页面</label></p>',
    [
      { label: '取消', cls: 'btn' },
      { label: '创建', cls: 'btn primary', id: 'np-ok' },
    ],
    (modal) => {
      $('np-ok').addEventListener('click', async () => {
        const nbId = $('np-nb').value;
        const kind = $('np-kind').checked ? 'task' : 'document';
        closeModals();
        await newPage(nbId, null, kind);
      });
    }
  );
}

function pageMoreMenu(page) {
  showMenu('页面操作', [
    { label: '🕘 版本历史', fn: () => showHistory(page) },
    { label: '📄 导出为 Markdown', fn: async () => {if(await saveNow())await download('/api/export/page/' + page.id);} },
    { label: '📋 复制页面', fn: () => duplicatePage(page) },
    { label: '🗑 移到回收站', fn: () => trashPage(page), danger: true },
  ]);
}

async function duplicatePage(page) {
  if(!await saveNow())return;
  try {
    const np = await api.post('/api/pages/' + page.id + '/duplicate');
    await loadState();
    navigate({ view: 'page', pageId: np.id });
    toast('已复制');
  } catch (err) { toast(err.message, 'error'); }
}

async function trashPage(page) {
  if (!confirm('将「' + page.title + '」移到回收站？')) return;
  try {
    await api.del('/api/pages/' + page.id);
    await loadState();
    navigate({ view: 'home' });
    toast('已移到回收站');
  } catch (err) { toast(err.message, 'error'); }
}

async function download(url, filename) {
  try {
    const response = await api.get(url);
    const blob = await response.blob();
    const disposition=response.headers.get('content-disposition') || '';
    const encoded=disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const objectUrl=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=objectUrl;
    a.download=filename || (encoded ? decodeURIComponent(encoded[1]) : 'notebook-export.zip');
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(objectUrl),1000);
  } catch(error) {toast(error.message,'error');}
}

// ---------- search ----------

async function doSearch(q) {
  try {
    const res = await api.get('/api/search', { q });
    const box = $('search-results');
    box.innerHTML = '';
    if (!res.items.length) {
      box.innerHTML = '<div class="search-empty">没有匹配「' + esc(q) + '」的结果</div>';
    } else {
      for (const r of res.items.slice(0, 12)) {
        const item = document.createElement('a');
        item.className = 'search-item';
        item.href = '#/page/' + r.pageId;
        const nb = state.notebooks.find(n => n.id === r.notebookId);
        item.innerHTML = '<span class="search-title">' + esc(r.icon || (r.kind === 'task' ? '✅' : '📄')) + ' ' + esc(r.title) + '</span>' +
          '<span class="search-preview muted">' + esc((r.preview || '').slice(0, 70)) + '</span>' +
          '<span class="muted small">' + esc(nb ? nb.name : '') + ' · ' + fmtDate(r.updatedAt) + '</span>';
        box.appendChild(item);
      }
    }
    box.classList.remove('hidden');
  } catch {}
}

function showSearch(q) {
  $('list-view').classList.remove('hidden');
  $('list-title').textContent = '搜索: ' + q;
  $('btn-new-page').style.display = 'none';
  $('btn-import').style.display = 'none';
  $('btn-export-all').style.display = 'none';
  const list = $('page-list');
  list.innerHTML = '<div class="empty-state">搜索中…</div>';
  api.get('/api/search', { q }).then(res => {
    renderPageList(res.items.map(r => ({ ...r, id: r.pageId })), 'search');
  });
}

// ---------- editor chrome bindings ----------

function bindEditorChrome() {
  // tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      state.editorMode = tab.dataset.mode;
      localStorage.setItem('nb-mode', state.editorMode);
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
      applyEditorMode();
    });
  });
  // toolbar
  document.querySelectorAll('.tb').forEach(btn => {
    btn.addEventListener('click', () => toolbarCmd(btn.dataset.cmd));
  });
  // editor input
  $('editor').addEventListener('input', () => {
    state.dirty = true;
    scheduleSave();
    renderPreview();
    updateEditorStats();
  });
  $('editor').addEventListener('keyup', updateEditorStats);
  $('editor').addEventListener('click', updateEditorStats);
  $('editor').addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const { ta, start, end } = editorSel();
      ta.value = ta.value.slice(0, start) + '  ' + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = start + 2;
      scheduleSave();
    }
  });
  $('page-title-input').addEventListener('input', scheduleSave);
  // meta fields
  $('page-due').addEventListener('change', scheduleSave);
  $('page-reminder').addEventListener('change', scheduleSave);
  $('page-recurrence').addEventListener('change', scheduleSave);
  $('page-notebook-select').addEventListener('change', (e) => {
    fillSectionSelect(e.target.value, null);
    scheduleSave();
  });
  $('page-section-select').addEventListener('change', scheduleSave);
  $('kind-document').addEventListener('click', () => setKind('document'));
  $('kind-task').addEventListener('click', () => setKind('task'));
  $('btn-important').addEventListener('click', async () => {
    if (!state.currentPage) return;
    const important = !state.currentPage.important;
    state.currentPage.important = important;
    $('btn-important').classList.toggle('on', important);
    scheduleSave();
  });
  $('btn-favorite').addEventListener('click', async () => {
    if (!state.currentPage) return;
    const favorite = !state.currentPage.favorite;
    state.currentPage.favorite = favorite;
    $('btn-favorite').textContent = favorite ? '★' : '☆';
    $('btn-favorite').classList.toggle('on', favorite);
    scheduleSave();
  });
  $('page-icon').addEventListener('click', async () => {
    const emoji = prompt('设置图标 (emoji):', state.currentPage.icon || '');
    if (emoji === null) return;
    state.currentPage.icon = emoji || null;
    $('page-icon').textContent = emoji || (state.currentPage.kind === 'task' ? '✅' : '📄');
    scheduleSave();
  });
  $('btn-history').addEventListener('click', () => state.currentPage && showHistory(state.currentPage));
  $('btn-export-page').addEventListener('click', async () => {if (state.currentPage && await saveNow()) download('/api/export/page/' + state.currentPage.id);});
  $('btn-more').addEventListener('click', () => state.currentPage && pageMoreMenu(state.currentPage));
  $('btn-inspector-close').addEventListener('click', closeSidePanels);
  $('btn-navigation').addEventListener('click', () => {
    const open = !$('app').classList.contains('navigation-open');
    closeSidePanels(); $('app').classList.toggle('navigation-open', open);
    $('btn-navigation').setAttribute('aria-expanded', String(open));
    $('panel-backdrop').hidden = !open;
  });
  $('btn-panel-close').addEventListener('click', closeSidePanels);
  $('panel-backdrop').addEventListener('click', closeSidePanels);
  $('btn-page-info').addEventListener('click', () => {
    const open = $('inspector').classList.contains('hidden');
    closeSidePanels(); $('inspector').classList.toggle('hidden', !open);
    $('btn-page-info').setAttribute('aria-expanded', String(open));
    $('panel-backdrop').hidden = !open || window.innerWidth > 1100;
  });
  $('btn-editor-back').addEventListener('click', () => navigate({ view: 'home' }));
  $('btn-save-retry').addEventListener('click', () => {
    const entry = saves.get(state.currentPageId);
    if (entry?.error?.status === 409) showConflict(); else void saveNow();
  });
  $('btn-document-details').addEventListener('click', () => $('page-meta-row').classList.toggle('expanded'));
  window.addEventListener('resize', () => {closeSidePanels(); applyEditorMode();});
  window.addEventListener('online', () => { void saves.retryAll(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {saves.persistAll(); void saveNow();}
  });

  // quick nav
  $('btn-new-page').addEventListener('click', newPageDialog);
  $('btn-import').addEventListener('click', () => {
    if (!state.notebooks.length) { toast('请先创建笔记本', 'warn'); return; }
    importDialog(state.notebooks[0]);
  });
  $('btn-export-all').addEventListener('click', async () => {if (await flushAllSaves()) download('/api/export/all');});
  $('btn-graph').addEventListener('click', () => navigate({ view: 'graph' }));
  $('btn-settings').addEventListener('click', showSettings);
  $('btn-graph-back').addEventListener('click', () => history.back());
  $('graph-show-links').addEventListener('change', () => showGraph());

  // task filters
  document.querySelectorAll('.task-filter').forEach(b => {
    b.addEventListener('click', () => showTasks(b.dataset.scope));
  });
  // add tag button
  $('btn-add-tag').addEventListener('click', () => {
    const name = prompt('新标签名称:', '');
    if (!name || !name.trim()) return;
    api.post('/api/tags', { name: name.trim() }).then(async () => {
      await loadState();
      toast('标签已创建');
    }).catch(err => toast(err.message, 'error'));
  });
}

function setKind(kind) {
  if (!state.currentPage) return;
  state.currentPage.kind = kind;
  $('page-meta-row').classList.toggle('is-task', kind === 'task');
  $('kind-document').classList.toggle('active', kind === 'document');
  $('kind-task').classList.toggle('active', kind === 'task');
  $('page-icon').textContent = state.currentPage.icon || (kind === 'task' ? '✅' : '📄');
  scheduleSave();
}

function applyEditorMode() {
  const body = $('editor-body');
  const mode = isNarrow() && state.editorMode === 'split' ? 'edit' : state.editorMode;
  document.querySelectorAll('[data-mode]').forEach(el => {el.classList.toggle('active', el.dataset.mode === mode);el.setAttribute('aria-pressed',String(el.dataset.mode === mode));});
  body.classList.toggle('split', mode === 'split');
  body.classList.toggle('edit-only', mode === 'edit');
  body.classList.toggle('preview-only', mode === 'preview');
  $('editor').classList.toggle('hidden', mode === 'preview');
  $('preview').classList.toggle('hidden', mode === 'edit');
}

window.addEventListener('beforeunload', (event) => {
  saves.persistAll();
  if (saves.hasPending()) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => saves.persistAll());

// ---------- init ----------
applyEditorMode();
bindEditorChrome();
boot().catch(err => {
  console.error(err);
  document.body.innerHTML = '<div style="padding:40px;font-family:monospace">启动失败: ' + esc(err.message) + '</div>';
});
// ---------- routing & views ----------

async function onRoute() {
  const version = ++routeVersion;
  const route = parseRoute();
  if (state.currentPageId) void saves.flush(state.currentPageId).catch(() => {});
  void maybeSavePosition();
  closeModals(); closeSidePanels(); hideAllViews();
  state.currentPageId = null; state.currentPage = null; state.draftDecision=false;
  $('editor').value = ''; $('preview').innerHTML = '';
  document.querySelectorAll('.draft-bar').forEach(el => el.remove());
  try {
    if (route.view === 'page') await openPage(route.pageId, version);
    else if (route.view === 'notebook') showHome('notebook', route.notebookId);
    else if (route.view === 'section') showHome('section', route.sectionId);
    else if (route.view === 'tag') showHome('tag', route.tagId);
    else if (route.view === 'favorites') showHome('favorites');
    else if (route.view === 'search') showSearch(route.q || '');
    else if (route.view === 'tasks') await showTasks('open');
    else if (route.view === 'trash') await showTrash();
    else if (route.view === 'reminders') await showReminders();
    else if (route.view === 'graph') await showGraph();
    else { showHome('home'); if (route.view === 'settings') showSettings(); }
  } catch (error) {
    if (version !== routeVersion) return;
    hideAllViews(); showHome('home');
    toast(error.message || '无法打开页面，已保留未保存草稿', 'error');
  }
}

function hideAllViews() {
  $('list-view').classList.add('hidden');
  $('editor-view').classList.add('hidden');
  $('tasks-view').classList.add('hidden');
  $('graph-view').classList.add('hidden');
  $('inspector').classList.add('hidden');
}

function titleFor(route) {
  if (route.view === 'notebook') {
    const nb = state.notebooks.find(n => n.id === route.notebookId);
    return (nb ? nb.emoji + ' ' + nb.name : '笔记本');
  }
  if (route.view === 'section') {
    const sec = [...allSections()].find(s => s.id === route.sectionId);
    return '分区: ' + (sec ? sec.name : '?');
  }
  if (route.view === 'tag') {
    const tag = state.tags.find(t => t.id === route.tagId);
    return '标签: ' + (tag ? tag.name : '?');
  }
  if (route.view === 'favorites') return '⭐ 收藏';
  if (route.view === 'home') return '全部笔记';
  return '笔记';
}

function allSections() {
  const out = [];
  for (const nb of state.notebooks) for (const s of (nb.sections || [])) out.push(s);
  return out;
}

function showHome(kind, id) {
  $('list-view').classList.remove('hidden');
  $('list-title').textContent = titleFor({ view: kind, notebookId: id, sectionId: id, tagId: id });
  $('btn-new-page').style.display = 'inline-block';
  const list = $('page-list');
  list.innerHTML = '';
  $('btn-import').style.display = ''; $('btn-export-all').style.display = '';
  let pages = [...state.pages.values()].filter(p => !p.deletedAt && !p.locked);
  if (kind === 'notebook') pages = pages.filter(p => p.notebookId === id);
  if (kind === 'section') pages = pages.filter(p => p.sectionId === id);
  if (kind === 'tag') {
    const tagPages = new Set();
    for (const nb of state.notebooks) {
      // fetch pages by tag from server
    }
    loadTagPages(id).then(items => renderPageList(items, kind, id));
    return;
  }
  if (kind === 'favorites') pages = pages.filter(p => p.favorite);
  pages.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  renderPageList(pages, kind, id);
}

async function loadTagPages(tagId) {
  const res = await api.get('/api/pages', { tagId });
  return res.items;
}

function renderPageList(pages, kind, id) {
  const list = $('page-list');
  list.innerHTML = '';
  if (!pages.length) {
    list.innerHTML = '<div class="empty-state">📄 这里还没有笔记<br><span class="muted">点击右上角「＋ 新建笔记」开始</span></div>';
    return;
  }
  for (const p of pages) {
    const card = document.createElement('div');
    card.className = 'page-card';
    const nb = state.notebooks.find(n => n.id === p.notebookId);
    const sec = p.sectionId ? [...allSections()].find(s => s.id === p.sectionId) : null;
    card.innerHTML =
      '<div class="page-card-icon">' + esc(p.icon || (p.kind === 'task' ? '✅' : '📄')) + '</div>' +
      '<div class="page-card-main">' +
      '<div class="page-card-title">' + esc(p.title || '无标题') +
      (p.favorite ? ' <span class="fav-mark">★</span>' : '') +
      (p.kind === 'task' ? ' <span class="kind-chip">任务</span>' : '') +
      (p.completedAt ? ' <span class="done-chip">已完成</span>' : '') +
      '</div>' +
      '<div class="page-card-preview">' + esc(p.preview || '') + '</div>' +
      '<div class="page-card-meta">' +
      '<span>' + esc(nb ? nb.emoji + ' ' + nb.name : '') + '</span>' +
      (sec ? '<span>› ' + esc(sec.name) + '</span>' : '') +
      '<span>' + fmtDate(p.updatedAt) + '</span>' +
      (p.dueAt ? '<span class="due-chip">⏰ ' + fmtDate(p.dueAt) + '</span>' : '') +
      '</div></div>';
    card.addEventListener('click', () => navigate({ view: 'page', pageId: p.id }));
    list.appendChild(card);
  }
}

// ---------- page editor ----------

async function openPage(pageId, version = routeVersion) {
  let page = await api.get('/api/pages/' + pageId);
  if (version !== routeVersion) return;
  const entry = saves.register(page);
  // Returning to a page must show its newest in-flight snapshot, not an older GET.
  if (entry.pending) page = {...page,...entry.pending.patch};
  setDraftDecision(false);
  $('editor-view').classList.remove('hidden');
  $('inspector').classList.toggle('hidden', window.innerWidth <= 1100);
  $('page-meta-row').classList.toggle('is-task', page.kind === 'task');
  $('page-meta-row').classList.remove('expanded');
  $('save-status').textContent = entry.pending ? '未保存，草稿已保留' : '已保存';
  $('btn-save-retry').classList.toggle('hidden', !entry.error);
  applyEditorMode();
  state.currentPageId = pageId;
  state.currentPage = page;
  state.currentBody = page.markdown || '';
  state.lastSavedBody = state.currentBody;
  state.dirty = !!entry.pending;

  $('page-icon').textContent = page.icon || (page.kind === 'task' ? '✅' : '📄');
  $('page-title-input').value = page.title || '';
  $('editor').value = state.currentBody;
  $('btn-favorite').textContent = page.favorite ? '★' : '☆';
  $('btn-favorite').classList.toggle('on', !!page.favorite);
  $('btn-important').classList.toggle('on', !!page.important);
  $('kind-document').classList.toggle('active', page.kind !== 'task');
  $('kind-task').classList.toggle('active', page.kind === 'task');
  $('page-due').value = toLocalInput(page.dueAt);
  $('page-reminder').value = toLocalInput(page.reminderAt);
  $('page-recurrence').value = page.recurrenceRule || '';

  // notebook & section selects
  const nbSel = $('page-notebook-select');
  nbSel.innerHTML = state.notebooks.filter(n => !n.locked || n.unlocked).map(n => '<option value="' + n.id + '">' + esc(n.emoji + ' ' + n.name) + '</option>').join('');
  nbSel.value = page.notebookId;
  fillSectionSelect(page.notebookId, page.sectionId);

  renderPreview();
  updateEditorStats();
  updateInspector(page);
  renderSidebar();

  // draft recovery
  const draftKey = 'nb-draft-' + pageId;
  document.querySelectorAll('.draft-bar').forEach(el => el.remove());
  const raw = localStorage.getItem(draftKey);
  if (raw && !entry.pending) {
    try {
      const draft = JSON.parse(raw);
      if (draft.patch || draft.body !== state.currentBody) showDraftBanner(draft, pageId);
    } catch { showDraftBanner({raw}, pageId); }
  }
  // reading position
  const pos = page.position;
  if (pos && pos.viewportFraction) {
    setTimeout(() => {
      const body = $('editor-body');
      if (body.scrollHeight > body.clientHeight) {
        body.scrollTop = (body.scrollHeight - body.clientHeight) * (pos.viewportFraction || 0);
      }
    }, 120);
  }
}

function fillSectionSelect(notebookId, selected) {
  const nb = state.notebooks.find(n => n.id === notebookId);
  const sel = $('page-section-select');
  sel.innerHTML = '<option value="">（无分区）</option>' + (nb ? nb.sections.map(s => '<option value="' + s.id + '">' + esc(s.name) + '</option>').join('') : '');
  sel.value = selected || '';
}

function setDraftDecision(pending) {
  state.draftDecision=pending;
  $('editor').readOnly=pending;
  document.querySelectorAll('#editor-header button,#editor-header input,#page-meta-row input,#page-meta-row select,#page-meta-row button,.editor-tabs button').forEach(el=>el.disabled=pending);
}

function showDraftBanner(draft, pageId) {
  setDraftDecision(true);
  recordDiagnostic('draft.recovery.available');
  const bar = document.createElement('div');
  bar.className = 'draft-bar'; bar.setAttribute('role', 'status');
  bar.innerHTML = '检测到本机未保存草稿 ' +
    (draft.raw ? '（格式异常，可下载保留）' : '<button class="btn small" id="draft-use">使用草稿</button> ') +
    '<button class="btn small" id="draft-download">下载草稿</button> ' +
    '<button class="btn small" id="draft-discard">丢弃草稿</button>';
  $('editor-header').before(bar);
  bar.querySelector('#draft-use')?.addEventListener('click', () => {
    if (state.currentPageId !== pageId) return;
    recordDiagnostic('draft.recovery.used');
    const patch = draft.patch || { markdown: draft.body };
    $('editor').value = patch.markdown ?? '';
    if (patch.title !== undefined) $('page-title-input').value = patch.title;
    state.currentPage = { ...state.currentPage, ...patch };
    if (patch.notebookId) {$('page-notebook-select').value = patch.notebookId; fillSectionSelect(patch.notebookId, patch.sectionId);}
    for (const [field,id] of [['dueAt','page-due'],['reminderAt','page-reminder']]) if (field in patch) $(id).value = toLocalInput(patch[field]);
    if ('recurrenceRule' in patch) $('page-recurrence').value = patch.recurrenceRule || '';
    const entry = saves.get(pageId);
    if (draft.baseUpdatedAt) entry.expectedUpdatedAt = draft.baseUpdatedAt;
    $('btn-favorite').textContent=state.currentPage.favorite?'★':'☆';
    $('btn-important').classList.toggle('on',!!state.currentPage.important);
    $('kind-task').classList.toggle('active',state.currentPage.kind==='task');
    $('kind-document').classList.toggle('active',state.currentPage.kind!=='task');
    $('page-meta-row').classList.toggle('is-task',state.currentPage.kind==='task');
    setDraftDecision(false);renderPreview(); updateEditorStats(); bar.remove(); scheduleSave();
  });
  bar.querySelector('#draft-download').addEventListener('click', () => downloadDraft(pageId, draft));
  bar.querySelector('#draft-discard').addEventListener('click', async () => {
    if (!confirm('丢弃此本机草稿并保留服务器版本？')) return;
    try {saves.discard(pageId);bar.remove(); if (state.currentPageId === pageId) await openPage(pageId);}
    catch (error) {toast(error.message,'error');}
  });
}

function downloadDraft(pageId, draft) {
  const url = URL.createObjectURL(new Blob([draft.raw || JSON.stringify(draft, null, 2)], {type:'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = 'notebook-draft-' + pageId + '.json';link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showConflict() {
  const id = state.currentPageId;
  openModal('此笔记已在其他设备修改', '<p>你的修改已保存在本机草稿中。可先下载草稿，再载入服务器版本进行比较。不会自动覆盖任何一方。</p>', [
    {label:'下载本机草稿',cls:'btn',id:'conflict-download'},
    {label:'保留草稿，稍后处理',cls:'btn',id:'conflict-cancel'},
    {label:'丢弃本机修改并载入服务器',cls:'btn danger',id:'conflict-server'},
  ], () => {
    $('conflict-download').onclick = () => {const entry=saves.get(id);downloadDraft(id,entry?.pending?{version:2,patch:entry.pending.patch,baseUpdatedAt:entry.expectedUpdatedAt}:JSON.parse(localStorage.getItem('nb-draft-'+id)||'{}'));};
    $('conflict-cancel').onclick = closeModals;
    $('conflict-server').onclick = async () => {saves.discard(id);closeModals();await openPage(id);};
  });
}

function renderPreview() {
  const body = $('editor').value;
  $('preview').innerHTML = renderMarkdown(body);
  updateLinkStat();
}

function updateLinkStat() {
  const body = $('editor').value;
  const links = (body.match(/\[\[[^\]]+\]\]/g) || []).length;
  const words = countText(body);
  $('stat-words').textContent = words + ' 字';
  $('stat-links').textContent = links ? links + ' 个内部链接' : '';
}

function countText(text) {return (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]+/gu) || []).length;}

function updateEditorStats() {
  const v = $('editor').value;
  const words = countText(v);
  $('stat-words').textContent = words + ' 字';
  const pos = $('editor').selectionStart;
  const upTo = v.slice(0, pos);
  const line = upTo.split('\n').length;
  const col = upTo.length - upTo.lastIndexOf('\n');
  $('stat-cursor').textContent = '行 ' + line + ', 列 ' + col;
}

function editorSnapshot() {
  const page = state.currentPage;
  return {
    title: $('page-title-input').value.trim() || '无标题', markdown: $('editor').value,
    icon: page.icon ?? null, favorite: !!page.favorite, kind: page.kind,
    important: !!page.important, dueAt: fromLocalInput($('page-due').value),
    reminderAt: fromLocalInput($('page-reminder').value), recurrenceRule: $('page-recurrence').value || null,
    sectionId: $('page-section-select').value || null, notebookId: $('page-notebook-select').value,
  };
}

async function flushAllSaves() {
  if(state.draftDecision){toast('请先选择使用或丢弃本机草稿','warn');return false;}
  const results=await saves.retryAll();
  if(results.some(r=>r.status==='rejected')) {toast('请先处理未保存内容或版本冲突','warn');return false;}
  return true;
}

async function saveNow() {
  if (!state.currentPageId) return true;
  if (state.draftDecision) {toast('请先选择使用或丢弃本机草稿','warn');return false;}
  try { await saves.flush(state.currentPageId); return true; }
  catch { return false; }
}

function scheduleSave() {
  if (!state.currentPageId || !state.currentPage || state.draftDecision) return;
  saves.enqueue(state.currentPageId, editorSnapshot());
}

async function maybeSavePosition() {
  if (!state.currentPageId || !state.currentPage) return;
  const body = $('editor-body');
  if (!body) return;
  const fraction = body.scrollHeight > body.clientHeight ? body.scrollTop / (body.scrollHeight - body.clientHeight) : 0;
  try {
    await api.put('/api/pages/' + state.currentPageId + '/position', { viewportFraction: fraction, anchorOffset: 0 });
  } catch {}
}

// ---------- toolbar & editor commands ----------

function editorSel() {
  const ta = $('editor');
  return { ta, start: ta.selectionStart, end: ta.selectionEnd, text: ta.value };
}

function wrapSel(before, after, placeholder) {
  const { ta, start, end, text } = editorSel();
  const sel = text.slice(start, end) || placeholder || '';
  ta.value = text.slice(0, start) + before + sel + after + text.slice(end);
  ta.selectionStart = start + before.length;
  ta.selectionEnd = start + before.length + sel.length;
  ta.focus();
  scheduleSave();
  renderPreview();
  updateEditorStats();
}

function lineCmd(fn) {
  const { ta, start } = editorSel();
  const text = ta.value;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = text.indexOf('\n', start);
  const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
  const newLine = fn(line);
  ta.value = text.slice(0, lineStart) + newLine + text.slice(lineEnd < 0 ? undefined : lineEnd);
  ta.focus();
  scheduleSave();
  renderPreview();
}

function toolbarCmd(cmd) {
  if (!state.currentPageId) return;
  const { ta, start } = editorSel();
  switch (cmd) {
    case 'h1': lineCmd(l => (l.startsWith('# ') ? l.replace(/^# /, '') : '# ' + l)); break;
    case 'h2': lineCmd(l => (l.startsWith('## ') ? l.replace(/^## /, '') : '## ' + l)); break;
    case 'h3': lineCmd(l => (l.startsWith('### ') ? l.replace(/^### /, '') : '### ' + l)); break;
    case 'bold': wrapSel('**', '**', '粗体文字'); break;
    case 'italic': wrapSel('*', '*', '斜体'); break;
    case 'strike': wrapSel('~~', '~~', '删除线'); break;
    case 'code': wrapSel('`', '`', 'code'); break;
    case 'quote': lineCmd(l => '> ' + l); break;
    case 'list': lineCmd(l => (l.startsWith('- ') ? l.replace(/^- /, '') : '- ' + l)); break;
    case 'olist': lineCmd(l => (/^\d+\. /.test(l) ? l.replace(/^\d+\. /, '') : '1. ' + l)); break;
    case 'task': lineCmd(l => (/^- \[ \] /.test(l) ? l.replace(/^- \[ \] /, '') : /^- \[x\] /.test(l) ? l.replace(/^- \[x\] /, '') : '- [ ] ' + l)); break;
    case 'hr': lineCmd(l => (l ? '---' : '')); break;
    case 'math': wrapSel('$', '$', '公式'); break;
    case 'table': wrapSel('', '', '| 列1 | 列2 |\n| --- | --- |\n| 值1 | 值2 |'); break;
    case 'link': {
      const { text } = editorSel();
      const url = prompt('链接地址:', 'https://');
      if (url) wrapSel('[', '](' + url + ')', '链接文字');
      break;
    }
    case 'wikilink': {
      const pageTitles = [...state.pages.values()].filter(p => !p.deletedAt).map(p => p.title).filter(Boolean);
      const title = prompt('链接到页面标题:\n可用: ' + pageTitles.slice(0, 8).join(', ') + (pageTitles.length > 8 ? ' …' : ''));
      if (title && title.trim()) wrapSel('[[', ']]', title.trim());
      break;
    }
    case 'image': {
      const { ta } = editorSel();
      const input = $('asset-file-input');
      const targetPageId = state.currentPageId;
      input.onchange = async () => {
        const f = input.files[0];
        if (!f) return;
        try {
          const asset = await api.upload(targetPageId, f);
          if (state.currentPageId !== targetPageId) {toast('附件已上传至原笔记');return;}
          const md = '![' + esc(asset.filename) + '](/api/assets/' + asset.assetId + '/data)';
          const pos = ta.selectionStart;
          ta.value = ta.value.slice(0, pos) + md + ta.value.slice(ta.selectionEnd);
          scheduleSave();
          renderPreview();
          updateInspector(state.currentPage);
          toast('图片已上传并插入');
        } catch (err) { toast(err.message, 'error'); }
        input.value = '';
      };
      input.click();
      break;
    }
  }
}

function toggleTaskInPreview(checkbox) {
  if (!state.currentPageId) return;
  const idx = [...$('preview').querySelectorAll('input[data-task]')].indexOf(checkbox);
  // find the corresponding line in the editor markdown by scanning task lines
  const ta = $('editor');
  const lines = ta.value.split('\n');
  let taskIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)[-*+] \[([ xX])\] (.*)$/.exec(lines[i]);
    if (!m) continue;
    if (taskIdx === idx) {
      const checked = checkbox.checked;
      lines[i] = m[1] + '- [' + (checked ? 'x' : ' ') + '] ' + m[3];
      break;
    }
    taskIdx++;
  }
  ta.value = lines.join('\n');
  scheduleSave();
  renderPreview();
}

// ---------- inspector ----------

function updateInspector(page) {
  if (page.id !== state.currentPageId) return;
  state.currentPage = {...state.currentPage,tags:page.tags,steps:page.steps,assets:page.assets,comments:page.comments};
  state.inspectorPageId = page.id;
  // tags
  const tagBox = $('insp-tags');
  tagBox.innerHTML = '';
  for (const tag of (page.tags || [])) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.innerHTML = '<span class="tag-dot" style="background:' + esc(tag.color || '#888') + '"></span>' + esc(tag.name) + ' <button class="mini-btn" data-untag="' + tag.id + '">✕</button>';
    chip.querySelector('[data-untag]').addEventListener('click', () => setPageTags(page, page.tags.filter(t => t.id !== tag.id).map(t => t.id)));
    tagBox.appendChild(chip);
  }
  if (!(page.tags || []).length) {
    tagBox.innerHTML = '<span class="muted small">无标签</span>';
  }
  const sel = $('insp-tag-select');
  const used = new Set((page.tags || []).map(t => t.id));
  sel.innerHTML = '<option value="">选择标签…</option>' + state.tags.filter(t => !used.has(t.id)).map(t => '<option value="' + t.id + '">' + esc(t.name) + '</option>').join('');
  $('btn-add-page-tag').onclick = () => {
    const id = sel.value;
    if (!id) return;
    setPageTags(page, [...(page.tags || []).map(t => t.id), id]);
  };

  // steps
  const stepBox = $('insp-steps');
  stepBox.innerHTML = '';
  for (const st of (page.steps || [])) {
    const row = document.createElement('div');
    row.className = 'step-row';
    row.innerHTML = '<label><input type="checkbox" data-step-check="' + st.id + '"' + (st.checked ? ' checked' : '') + '> <span class="step-text' + (st.checked ? ' done' : '') + '">' + esc(st.text) + '</span></label><button class="mini-btn" data-step-del="' + st.id + '">✕</button>';
    row.querySelector('[data-step-check]').addEventListener('change', (e) => {
      const steps = (page.steps || []).map(s => s.id === st.id ? { ...s, checked: e.target.checked } : s);
      saveSteps(page, steps);
      row.querySelector('.step-text').classList.toggle('done', e.target.checked);
    });
    row.querySelector('[data-step-del]').addEventListener('click', () => {
      saveSteps(page, (page.steps || []).filter(s => s.id !== st.id));
    });
    stepBox.appendChild(row);
  }
  if (!(page.steps || []).length) stepBox.innerHTML = '<span class="muted small">无步骤</span>';
  $('btn-add-step').onclick = () => {
    const v = $('insp-step-input').value.trim();
    if (!v) return;
    saveSteps(page, [...(page.steps || []), { text: v, checked: false }]);
    $('insp-step-input').value = '';
  };
  $('insp-step-input').onkeydown = (e) => { if (e.key === 'Enter') $('btn-add-step').click(); };

  // assets
  renderInspectorAssets(page);
  $('btn-insp-upload').onclick = () => $('insp-file-input').click();
  $('insp-file-input').onchange = async () => {
    for (const f of $('insp-file-input').files) {
      try {
        await api.upload(page.id, f);
      } catch (err) { toast(err.message, 'error'); }
    }
    $('insp-file-input').value = '';
    const updated = await api.get('/api/pages/' + page.id);
    updateInspector(updated);
  };

  // backlinks
  const bl = $('insp-backlinks');
  bl.innerHTML = '';
  for (const b of (page.backlinks || [])) {
    const a = document.createElement('a');
    a.className = 'backlink';
    a.href = '#/page/' + b.pageId;
    a.innerHTML = '← ' + esc(b.title) + ' <span class="muted small">' + esc((b.excerpt || '').slice(0, 60)) + '</span>';
    bl.appendChild(a);
  }
  if (!(page.backlinks || []).length) bl.innerHTML = '<span class="muted small">暂无反向链接</span>';

  // comments
  const cBox = $('insp-comments');
  cBox.innerHTML = '';
  for (const c of (page.comments || [])) {
    const row = document.createElement('div');
    row.className = 'comment-row';
    row.innerHTML = '<div class="comment-head"><b>' + esc(c.authorName) + '</b> <span class="muted small">' + fmtDate(c.createdAt) + '</span><button class="mini-btn" data-cdel="' + c.id + '">✕</button></div><div class="comment-body">' + esc(c.body) + '</div>';
    row.querySelector('[data-cdel]').addEventListener('click', async () => {
      await api.del('/api/comments/' + c.id);
      const p = await api.get('/api/pages/' + page.id);
      updateInspector(p);
    });
    cBox.appendChild(row);
  }
  if (!(page.comments || []).length) cBox.innerHTML = '<span class="muted small">无评论</span>';
  $('btn-add-comment').onclick = async () => {
    const body = $('insp-comment-body').value.trim();
    if (!body) return;
    await api.post('/api/pages/' + page.id + '/comments', { authorName: $('insp-comment-author').value || '我', body });
    $('insp-comment-body').value = '';
    const p = await api.get('/api/pages/' + page.id);
    updateInspector(p);
  };
  $('insp-comment-body').onkeydown = (e) => { if (e.key === 'Enter') $('btn-add-comment').click(); };
}

async function setPageTags(page, tagIds) {
  await api.put('/api/pages/' + page.id + '/tags', { tagIds });
  const p = await api.get('/api/pages/' + page.id);
  state.pages.set(page.id, p);
  updateInspector(p);
}

async function saveSteps(page, steps) {
  const res = await api.put('/api/pages/' + page.id + '/steps', { steps });
  const p = await api.get('/api/pages/' + page.id);
  p.steps = res.items;
  updateInspector(p);
}

async function renderInspectorAssets(page) {
  const box = $('insp-assets');
  box.innerHTML = '';
  for (const a of (page.assets || [])) {
    const item = document.createElement('div');
    item.className = 'asset-item';
    const url = '/api/assets/' + a.assetId + '/data';
    let media = '';
    if (a.kind === 'image') media = '<img src="' + url + '" loading="lazy">';
    else if (a.kind === 'audio') media = '<audio controls src="' + url + '"></audio>';
    else if (a.kind === 'video') media = '<video controls src="' + url + '" style="max-width:100%"></video>';
    else media = '<div class="file-icon">📎</div>';
    item.innerHTML = '<div class="asset-media">' + media + '</div>' +
      '<div class="asset-name">' + esc(a.filename) + '</div>' +
      '<div class="asset-actions">' +
      '<button class="btn small" data-a-ins>插入正文</button> ' +
      '<button class="btn small danger" data-a-del>删除</button></div>';
    item.querySelector('[data-a-ins]').addEventListener('click', () => {
      const ta = $('editor');
      const md = a.kind === 'image'
        ? '![' + esc(a.filename) + '](/api/assets/' + a.assetId + '/data)'
        : '[' + esc(a.filename) + '](/api/assets/' + a.assetId + '/data)';
      const pos = ta.selectionStart;
      ta.value = ta.value.slice(0, pos) + md + ta.value.slice(ta.selectionEnd);
      scheduleSave();
      renderPreview();
      toast('已插入');
    });
    item.querySelector('[data-a-del]').addEventListener('click', async () => {
      if (!confirm('删除此资产？')) return;
      await api.del('/api/assets/' + a.id);
      const updated = await api.get('/api/pages/' + page.id);
      updateInspector(updated);
    });
    box.appendChild(item);
  }
  if (!(page.assets || []).length) box.innerHTML = '<span class="muted small">无资产</span>';
}


function closeSidePanels() {
  $('app').classList.remove('navigation-open');
  $('btn-navigation').setAttribute('aria-expanded','false');
  $('btn-page-info').setAttribute('aria-expanded','false');
  if (window.innerWidth <= 1100) $('inspector').classList.add('hidden');
  $('panel-backdrop').hidden = true;
}
function showConnectionError() {
  $('connection-error').classList.remove('hidden');
  $('btn-reconnect').onclick = () => location.reload();
}
// Tree and card controls are keyboard reachable without nesting actual buttons.
document.addEventListener('keydown', (event) => {
  if (!['Enter',' '].includes(event.key)) return;
  if (event.target.matches('.page-row,.page-card,.nb-header,.sec-row,.nb-locked-row,.hist-item')) {event.preventDefault();event.target.click();}
});
function enhanceControls(root) {
  if (root.nodeType !== 1) return;
  const rows='.page-row,.page-card,.nb-header,.sec-row,.nb-locked-row,.hist-item';
  const apply=el=>{if(el.matches(rows)){el.tabIndex=0;el.setAttribute('role','button');}if(el.matches('button[title]:not([aria-label])'))el.setAttribute('aria-label',el.title);};
  apply(root);root.querySelectorAll(rows+',button[title]:not([aria-label])').forEach(apply);
}
const accessibleRows = new window.MutationObserver(records => {for(const record of records)record.addedNodes.forEach(enhanceControls);});
enhanceControls(document.body);
accessibleRows.observe(document.body,{childList:true,subtree:true});
const resizeViewport=()=>document.documentElement.style.setProperty('--app-height',(window.visualViewport?.height || window.innerHeight)+'px');
window.visualViewport?.addEventListener('resize',resizeViewport);resizeViewport();
