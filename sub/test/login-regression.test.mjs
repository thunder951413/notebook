import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {startServerFixture} from './server-fixture.mjs';
const until=async fn=>{for(let i=0;i<120;i++){if(fn())return;await new Promise(r=>setTimeout(r,25));}assert.fail('login UI timed out');};
test('first-visit login installs routing and authenticated reload skips login',async t=>{
 const f=await startServerFixture(t);
 const nb=f.store.createNotebook({name:'Test'});
 const a=await f.store.createPage({notebookId:nb.id,title:'A',markdown:'# A'});
 const b=await f.store.createPage({notebookId:nb.id,title:'B',markdown:'# B'});
 f.store.updateSettings({newPassword:'test-only-password'});await f.store.flush();
 const dom=new JSDOM(await readFile(new URL('../web/index.html',import.meta.url),'utf8'),{url:f.baseUrl+'/#/page/'+a.id,pretendToBeVisual:true});const w=dom.window;
 for(const key of ['window','document','location','localStorage','sessionStorage','CustomEvent','HTMLElement'])globalThis[key]=key==='window'?w:w[key];
 Object.defineProperty(globalThis,'navigator',{value:w.navigator,configurable:true});
 const originalFetch=globalThis.fetch,originalInterval=globalThis.setInterval,intervals=[];let cookie='';
 globalThis.setInterval=(...args)=>{const timer=originalInterval(...args);intervals.push(timer);return timer;};
 globalThis.fetch=async(url,opts={})=>{const headers=new Headers(opts.headers);if(cookie)headers.set('Cookie',cookie);const r=await originalFetch(new URL(url,f.baseUrl),{...opts,headers});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return r;};
 t.after(()=>{intervals.forEach(clearInterval);globalThis.setInterval=originalInterval;globalThis.fetch=originalFetch;dom.window.close();});
 const $=id=>document.getElementById(id);
 await import('../web/js/app.js');await until(()=>!$('login-screen').classList.contains('hidden'));
 $('login-password').value='test-only-password';$('login-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 await until(()=>$('page-title-input').value==='A');location.hash='#/page/'+b.id;
 await until(()=>$('page-title-input').value==='B');assert.equal($('login-screen').classList.contains('hidden'),true);
 // A fresh controller boot with the same browser session must accept /api/state.
 await import('../web/js/app.js?authenticated-reload');await new Promise(r=>setTimeout(r,100));await until(()=>$('page-title-input').value==='B');
 assert.equal($('app').classList.contains('hidden'),false);assert.equal($('login-screen').classList.contains('hidden'),true);
});
