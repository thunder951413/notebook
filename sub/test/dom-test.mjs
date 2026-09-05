import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, {
  url: (process.env.NOTEBOOK_TEST_URL || 'http://127.0.0.1:8080') + '/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
Object.defineProperty(window,'innerWidth',{value:1440,writable:true});
global.confirm = () => true; global.prompt = (message, value) => value || '测试标题';
global.window = window;
global.document = window.document;
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true });
global.location = window.location;
global.localStorage = window.localStorage;
global.sessionStorage = window.sessionStorage;
global.HTMLElement = window.HTMLElement;
global.CustomEvent = window.CustomEvent;
global.getComputedStyle = window.getComputedStyle;

// proxy fetch to the real server
const realFetch = globalThis.fetch;
global.fetch = (url, opts) => {
  const u = String(url).startsWith('http') ? url : (process.env.NOTEBOOK_TEST_URL || 'http://127.0.0.1:8080') + url;
  return realFetch(u, opts);
};
window.fetch = global.fetch;

const errors = [];
window.addEventListener('error', (e) => errors.push('window-error: ' + e.message));
const origErr = console.error;
console.error = (...a) => { errors.push('console.error: ' + a.map(x => String(x).slice(0, 200)).join(' ')); origErr(...a); };

// watchdog: kill if boot hangs
let bootDone = false;
setTimeout(() => {
  if (!bootDone) {
    console.log('WATCHDOG: boot did not finish in 6s — likely infinite loop');
    console.log('errors so far:', errors.slice(0, 10));
    process.exit(2);
  }
}, 6000);

// import the app modules
try {
  await import('../web/js/markdown.js');
  await import('../web/js/diff.js');
  await import('../web/js/graph.js');
  await import('../web/js/api.js');
  await import('../web/js/app.js');
} catch (e) {
  console.log('IMPORT FAIL:', e.message);
  process.exit(3);
}

// app.js boot() is async and called at module level; poll for completion
const start = Date.now();
while (Date.now() - start < 5000) {
  await new Promise(r => setTimeout(r, 100));
  const appVisible = !window.document.getElementById('app').classList.contains('hidden');
  const nbCount = window.document.querySelectorAll('.nb-block').length;
  if (appVisible && nbCount > 0) { bootDone = true; break; }
}
console.log('bootDone:', bootDone);
console.log('app hidden:', window.document.getElementById('app').classList.contains('hidden'));
console.log('nb blocks:', window.document.querySelectorAll('.nb-block').length);
console.log('sidebar html len:', window.document.getElementById('notebooks').innerHTML.length);
console.log('errors:', errors.slice(0, 10));
process.exit(bootDone ? 0 : 1);
