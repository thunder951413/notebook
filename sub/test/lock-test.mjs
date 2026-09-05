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
const cookieJar = new Map(); // name -> value
global.fetch = async (url, opts) => {
  opts = opts || {};
  const headers = new Headers(opts.headers || {});
  if (cookieJar.size && !headers.has('Cookie')) {
    headers.set('Cookie', [...cookieJar.entries()].map(([k, v]) => k + '=' + v).join('; '));
  }
  opts.headers = headers;
  const res = await realFetch(String(url).startsWith('http') ? url : (process.env.NOTEBOOK_TEST_URL || 'http://127.0.0.1:8080') + url, opts);
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const sc of setCookies) {
    const [pair] = sc.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const name = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      if (!val) cookieJar.delete(name); else cookieJar.set(name, val);
    }
  }
  return res;
};
window.fetch = global.fetch;
window.confirm = () => true;
window.prompt = (msg, def) => '锁测试密码123';

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

// cleanup leftover test notebooks from previous runs
const allNbs = await (await realFetch((process.env.NOTEBOOK_TEST_URL || 'http://127.0.0.1:8080') + '/api/state')).json();
for (const old of allNbs.notebooks.filter(n => n.name === '私密本')) {
  await realFetch((process.env.NOTEBOOK_TEST_URL || 'http://127.0.0.1:8080') + '/api/notebooks/' + old.id, { method: 'DELETE' });
}

// create a notebook + page, then lock it via API
const nbRes = await realFetch((process.env.NOTEBOOK_TEST_URL || 'http://127.0.0.1:8080') + '/api/notebooks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '私密本', emoji: '🔐' }) });
const nb = await nbRes.json();
await realFetch((process.env.NOTEBOOK_TEST_URL || 'http://127.0.0.1:8080') + '/api/pages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notebookId: nb.id, title: '秘密页面', markdown: '# 秘密内容\n不可见的内容' }) });
await realFetch((process.env.NOTEBOOK_TEST_URL || 'http://127.0.0.1:8080') + '/api/notebooks/' + nb.id + '/lock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: '锁测试密码123' }) });

await import('../web/js/markdown.js');
await import('../web/js/diff.js');
await import('../web/js/graph.js');
await import('../web/js/api.js');
await import('../web/js/app.js');
await waitFor(() => !$('app').classList.contains('hidden'));

// locked notebook shows lock row, not pages
await sleep(800);
check('locked notebook shows lock row', qa('.nb-locked-row').length >= 1);
check('locked notebook pages hidden', ![...qa('.page-row')].some(r => r.textContent.includes('秘密页面')));

// click the lock row -> unlock dialog
const lockRow = q('.nb-locked-row');
check('lock row clickable', !!lockRow);
if (lockRow) {
  lockRow.click();
  await sleep(400);
  check('unlock dialog opens', !!q('#unlock-pw'));
  // wrong password
  q('#unlock-pw').value = '错误密码';
  q('#unlock-ok').click();
  await sleep(500);
  check('wrong password rejected', !q('#unlock-err').classList.contains('hidden'));
  // correct password
  q('#unlock-pw').value = '锁测试密码123';
  q('#unlock-ok').click();
  await waitFor(() => qa('.nb-locked-row').length === 0, 6000);
  check('unlock succeeds', qa('.nb-locked-row').length === 0);
  check('locked pages now visible', [...qa('.page-row')].some(r => r.textContent.includes('秘密页面')));
  // open the secret page
  const secretRow = [...qa('.page-row')].find(r => r.textContent.includes('秘密页面'));
  secretRow.click();
  await waitFor(() => !$('editor-view').classList.contains('hidden'));
  await sleep(600);
  check('secret page opens after unlock', $('editor').value.includes('秘密内容'));
}

// ---- server login flow ----
await realFetch((process.env.NOTEBOOK_TEST_URL || 'http://127.0.0.1:8080') + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newPassword: '服务器密码1' }) });
// reload the app (re-import not possible; simulate by reloading the page scripts) -> instead: trigger login-required event
window.dispatchEvent(new CustomEvent('nb:login-required'));
await sleep(300);
check('login screen shows', !$('login-screen').classList.contains('hidden'));
check('app hidden during login', $('app').classList.contains('hidden'));
// wrong password
q('#login-password').value = '错的';
q('#login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(800);
check('login error shown', !q('#login-error').classList.contains('hidden'));
// correct password
q('#login-password').value = '服务器密码1';
q('#login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(1500);
check('login succeeds, app shows', !$('app').classList.contains('hidden'));

// reset server password off (through the cookie-aware proxy)
await fetch((process.env.NOTEBOOK_TEST_URL || 'http://127.0.0.1:8080') + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newPassword: '' }) });
await fetch((process.env.NOTEBOOK_TEST_URL || 'http://127.0.0.1:8080') + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requireLogin: false }) });
await sleep(600); // let the server flush its debounced settings save

console.log('errors:', errors.slice(0, 5));
console.log(failed === 0 ? 'ALL LOCK/LOGIN TESTS PASSED' : failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);
