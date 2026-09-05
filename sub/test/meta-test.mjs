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
global.HTMLElement = window.HTMLElement;
const realFetch = globalThis.fetch;
global.fetch = (url, opts) => realFetch(String(url).startsWith('http') ? url : (process.env.NOTEBOOK_TEST_URL || 'http://127.0.0.1:8080') + url, opts);
window.fetch = global.fetch;
window.confirm = () => true;
window.prompt = (msg, def) => '测试';
const errors = [];
window.addEventListener('error', (e) => errors.push(e.message));
const $ = (id) => window.document.getElementById(id);
const q = (sel) => window.document.querySelector(sel);
const qa = (sel) => [...window.document.querySelectorAll(sel)];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('PASS', name);
  else { failed++; console.log('FAIL', name, extra || ''); }
};
const waitFor = async (fn, timeout = 6000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const v = fn(); if (v) return v; } catch {}
    await sleep(80);
  }
  return null;
};

await import('../web/js/markdown.js');
await import('../web/js/diff.js');
await import('../web/js/graph.js');
await import('../web/js/api.js');
await import('../web/js/app.js');
await waitFor(() => !$('app').classList.contains('hidden'));

// open first page
q('.page-row').click();
await waitFor(() => !$('editor-view').classList.contains('hidden'));
await sleep(500);
const pageId = location.hash.split('/').pop();

// set meta fields
$('page-due').value = '2026-09-01T10:00';
$('page-reminder').value = '2026-09-01T09:00';
$('page-recurrence').value = 'weekly';
const impBefore = await (await realFetch((process.env.NOTEBOOK_TEST_URL || 'http://127.0.0.1:8080') + '/api/pages/' + pageId)).json();
const wantImportant = !impBefore.important;
if (!wantImportant) {
  // if currently important, flip it off first and save, so the click below turns it on
  $('btn-important').click();
  await sleep(1200);
}
$('btn-important').click();
$('kind-task').click();
// trigger saves through change events
$('page-due').dispatchEvent(new window.Event('change', { bubbles: true }));
$('page-reminder').dispatchEvent(new window.Event('change', { bubbles: true }));
$('page-recurrence').dispatchEvent(new window.Event('change', { bubbles: true }));
await waitFor(() => $('save-status').textContent.includes('已保存'), 6000);
await sleep(300);

// verify on server
const res = await realFetch((process.env.NOTEBOOK_TEST_URL || 'http://127.0.0.1:8080') + '/api/pages/' + pageId);
const page = await res.json();
check('due saved', (page.dueAt || '').startsWith('2026-09-01'));
check('reminder saved', (page.reminderAt || '').startsWith('2026-09-01'));
check('recurrence saved', page.recurrenceRule === 'weekly');
check('important saved', page.important === true);
check('kind changed to task', page.kind === 'task');

// move page to another notebook
const nbSelect = $('page-notebook-select');
const targetNb = [...nbSelect.options].find(o => o.value !== page.notebookId);
if (targetNb) {
  nbSelect.value = targetNb.value;
  nbSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(1600); // debounced autosave (900ms) + server round trip
  const res2 = await realFetch((process.env.NOTEBOOK_TEST_URL || 'http://127.0.0.1:8080') + '/api/pages/' + pageId);
  const page2 = await res2.json();
  check('page moved to other notebook', page2.notebookId === targetNb.value);
}

// duplicate page
await q('[data-nav="home"]').click();
await sleep(400);
// find the page card and use the menu
const listHtml = q('#page-list').innerHTML;
check('home list renders', listHtml.length > 50);

console.log('errors:', errors.slice(0, 4));
console.log(failed === 0 ? 'ALL META TESTS PASSED' : failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);
