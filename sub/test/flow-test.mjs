import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: (process.env.NOTEBOOK_TEST_URL || 'http://127.0.0.1:8080') + '/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
Object.defineProperty(window,'innerWidth',{value:1440,writable:true});
global.confirm = () => true; global.prompt = (message, value) => value || '测试标题';
global.window = window;
global.document = window.document;
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true });
global.location = window.location;
global.localStorage = window.localStorage;
global.sessionStorage = window.sessionStorage;
global.CustomEvent = window.CustomEvent;
global.getComputedStyle = window.getComputedStyle;
global.HTMLElement = window.HTMLElement;
global.MouseEvent = window.MouseEvent;
const realFetch = globalThis.fetch;
global.fetch = (url, opts) => realFetch(String(url).startsWith('http') ? url : (process.env.NOTEBOOK_TEST_URL || 'http://127.0.0.1:8080') + url, opts);
window.fetch = global.fetch;
window.confirm = () => true;
window.prompt = (msg, def) => def || '测试标题';
window.alert = () => {};

const errors = [];
window.addEventListener('error', (e) => errors.push('window-error: ' + e.message));
const origErr = console.error;
console.error = (...a) => { errors.push('console.error: ' + a.map(x => String(x).slice(0, 200)).join(' ')); origErr(...a); };

const $ = (id) => window.document.getElementById(id);
const q = (sel) => window.document.querySelector(sel);
const qa = (sel) => [...window.document.querySelectorAll(sel)];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('PASS', name);
  else { failed++; console.log('FAIL', name, extra || ''); }
};
const waitFor = async (fn, timeout = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const v = fn(); if (v) return v; } catch {}
    await sleep(80);
  }
  return null;
};

// seed a tag via API (idempotent)
const tagList = await (await realFetch((process.env.NOTEBOOK_TEST_URL || 'http://127.0.0.1:8080') + '/api/tags')).json();
if (!tagList.items.some(t => t.name === '流程测试标签')) {
  await realFetch((process.env.NOTEBOOK_TEST_URL || 'http://127.0.0.1:8080') + '/api/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '流程测试标签', color: '#7c3aed' }),
  });
}

// ---- boot ----
await import('../web/js/markdown.js');
await import('../web/js/diff.js');
await import('../web/js/graph.js');
await import('../web/js/api.js');
await import('../web/js/app.js');
await waitFor(() => !$('app').classList.contains('hidden'));
check('boot shows app', !$('app').classList.contains('hidden'));
check('sidebar renders notebooks', qa('.nb-block').length >= 2);
check('sidebar renders page rows', qa('.page-row').length >= 1);
check('workspace name set', $('workspace-name').textContent.length > 0);

// ---- open a page ----
const firstRow = q('.page-row');
check('page rows exist', !!firstRow);
if (firstRow) {
  firstRow.click();
  await waitFor(() => !$('editor-view').classList.contains('hidden'));
  check('editor view opens', !$('editor-view').classList.contains('hidden'));
  check('editor has content', $('editor').value.length > 0);
  check('preview rendered', $('preview').innerHTML.length > 0);
  check('title input filled', $('page-title-input').value.length > 0);
  check('inspector visible', !$('inspector').classList.contains('hidden'));
  check('inspector tags section', qa('.ins-section').length >= 4);
}

// ---- edit & autosave ----
const firstId = location.hash.split('/').pop();
const oldBody = $('editor').value;
$('editor').value = '# 自动保存测试\n' + oldBody;
$('editor').dispatchEvent(new window.Event('input', { bubbles: true }));
await waitFor(() => $('save-status').textContent.includes('已保存'), 6000);
check('autosave completes', $('save-status').textContent.includes('已保存'));
// verify on server
const pageRes = await realFetch((process.env.NOTEBOOK_TEST_URL || 'http://127.0.0.1:8080') + '/api/pages/' + firstId);
const pageData = await pageRes.json();
check('server received edit', (pageData.markdown || '').includes('自动保存测试'));
check('server updated title from heading', pageData.title.includes('自动保存测试'));
check('revision was created', pageData.revisionCount >= 1);

// ---- preview mode ----
q('[data-mode="preview"]').click();
await sleep(200);
check('preview mode hides editor', $('editor').classList.contains('hidden'));
check('preview mode shows preview', !$('preview').classList.contains('hidden'));
q('[data-mode="split"]').click();
await sleep(200);
check('split mode shows both', !$('editor').classList.contains('hidden') && !$('preview').classList.contains('hidden'));

// ---- task checkbox toggle in preview ----
const taskMd = '# 任务测试\n\n- [ ] 待办甲\n- [x] 已完成乙\n';
$('editor').value = taskMd;
$('editor').dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(200);
const boxes = qa('#preview input[data-task]');
check('task checkboxes rendered', boxes.length === 2);
if (boxes.length === 2) {
  boxes[0].click(); // checks the first box
  await sleep(300);
  const body = $('editor').value;
  check('checkbox toggles markdown', body.includes('- [x] 待办甲'));
}

// ---- favorite & important ----
const favBefore = $('btn-favorite').textContent;
$('btn-favorite').click();
await sleep(300);
check('favorite toggled', $('btn-favorite').textContent !== favBefore);

// ---- history modal ----
$('btn-history').click();
await sleep(500);
check('history modal opens', !!q('#history-list'));
check('history has items', qa('.hist-item').length >= 1);
// click first revision -> diff shown
const histItem = q('.hist-item');
if (histItem) {
  histItem.click();
  await sleep(600);
  check('history diff renders', q('#history-diff').innerHTML.length > 0);
}
window.document.querySelector('[data-close]') && window.document.querySelector('[data-close]').click();
await sleep(200);

// ---- inspector: add tag ----
const tagSel = $('insp-tag-select');
check('tag select populated', tagSel.options.length >= 1);
if (tagSel.options.length > 1) {
  tagSel.value = tagSel.options[1].value;
  $('btn-add-page-tag').click();
  await sleep(500);
  check('tag chip added', qa('#insp-tags .tag-chip').length >= 1);
}

// ---- inspector: add step ----
$('insp-step-input').value = '新增步骤';
$('btn-add-step').click();
await sleep(500);
check('step added', qa('.step-row').length >= 1);

// ---- inspector: comment ----
$('insp-comment-body').value = '这是一条测试评论';
$('btn-add-comment').click();
await sleep(600);
check('comment added', qa('.comment-row').length >= 1);

// ---- tasks view ----
location.hash = '#/tasks';
await waitFor(() => !$('tasks-view').classList.contains('hidden'));
await sleep(600);
check('tasks view shows', !$('tasks-view').classList.contains('hidden'));
check('tasks filters present', qa('.task-filter').length === 5);

// ---- trash view ----
location.hash = '#/trash';
await waitFor(() => $('list-title') && $('list-title').textContent.includes('回收站'));
await sleep(800);
check('trash view shows', $('list-title').textContent.includes('回收站'));

// ---- graph view ----
location.hash = '#/graph';
await waitFor(() => !$('graph-view').classList.contains('hidden'));
await sleep(1500);
check('graph svg rendered', $('graph-svg').innerHTML.length > 100);

// ---- search ----
$('search-input').value = '任务';
$('search-input').dispatchEvent(new window.Event('input', { bubbles: true }));
await waitFor(() => qa('.search-item').length > 0, 4000);
check('search results appear', qa('.search-item').length > 0);

// ---- settings modal ----
$('btn-settings').click();
await sleep(300);
check('settings modal opens', !!q('#set-name'));
q('[data-close]') && q('[data-close]').click();

// ---- tags panel ----
check('tags panel renders', qa('.tag-link').length >= 1);

// ---- back to home ----
location.hash = '#/';
await waitFor(() => $('list-title') && $('list-title').textContent.includes('全部笔记'));
check('home view works', $('list-title').textContent.includes('全部笔记'));

console.log('errors:', errors.slice(0, 6));
console.log(failed === 0 ? 'ALL FLOW TESTS PASSED' : failed + ' TESTS FAILED');
process.exit(failed === 0 ? 0 : 1);
