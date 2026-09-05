import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createDiagnostics,errorDetails} from '../server/diagnostics.js';
import {startServerFixture} from './server-fixture.mjs';

test('server logs enforce rotation budget and omit arbitrary data/exception secrets',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'notebook-diag-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const log=createDiagnostics(dir,{maxBytes:1024,files:4});
 for(let i=0;i<60;i++)await log.record('save.done',{count:i,body:'SECRET NOTE BODY',password:'TOKEN',error:new Error('private https://user:password@host/private-note')});
 await log.close();const names=await fs.readdir(dir);assert.ok(names.length<=4);
 let total=0;for(const name of names){const size=(await fs.stat(path.join(dir,name))).size;assert.ok(size<=1024);total+=size;}
 assert.ok(total<=4096);const output=(await log.exportLogs()).toString();
 assert.doesNotMatch(output,/SECRET|TOKEN|password|private-note|https:/);assert.match(output,/"count":59/);
 for(const line of output.trim().split('\n'))assert.ok(JSON.parse(line).sessionId);
});
test('log flooding is bounded, duplicates summarized, and storage failures do not escape',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'notebook-diag-flood-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const log=createDiagnostics(dir);await Promise.all(Array.from({length:300},()=>log.record('sync.failed',{level:'error',error:new TypeError('never persist this message')})));
 await log.record('sync.done');await log.close();const lines=(await log.exportLogs()).toString().trim().split('\n').map(JSON.parse);
 assert.equal(lines.length,2);assert.equal(lines[1].suppressedSinceLast,299);
 const invalid=path.join(dir,'not-a-directory');await fs.writeFile(invalid,'x');const bad=createDiagnostics(invalid);
 await assert.doesNotReject(bad.record('save.failed',{level:'error'}));await assert.doesNotReject(bad.close());
 const flooded=createDiagnostics(path.join(dir,'bounded'));await Promise.all(Array.from({length:1000},(_,i)=>flooded.record('save.done',{count:i})));await flooded.close();
 const floodLines=(await flooded.exportLogs()).toString().trim().split('\n').map(JSON.parse);assert.ok(floodLines.length<=129);assert.ok(floodLines.some(v=>v.droppedSinceLast>=872));
});
test('request IDs correlate failures with logs and export requires server authentication',async t=>{
 const f=await startServerFixture(t);const operationId=randomUUID();
 const response=await f.client.request('/api/pages/not-found',{headers:{'X-Request-Id':operationId}});
 assert.equal(response.status,404);assert.equal(response.headers.get('x-request-id'),operationId);
 await new Promise(r=>setImmediate(r));await f.store.diagnostics.flush();
 const records=(await f.store.diagnostics.exportLogs()).toString().trim().split('\n').map(JSON.parse);
 const entry=records.find(v=>v.operationId===operationId);assert.equal(entry.route,'/api/pages/:id');assert.equal(entry.resourceRef?.length,12);assert.ok(entry.durationMs>=0);
 f.store.updateSettings({newPassword:'diagnostic-test-only'});await f.store.flush();
 assert.equal((await f.client.request('/api/diagnostics/export')).status,401);
 await f.client.request('/api/login',{method:'POST',json:{password:'diagnostic-test-only'}});
 const exported=await f.client.request('/api/diagnostics/export');assert.equal(exported.status,200);assert.equal(exported.headers.get('cache-control'),'no-store');
 assert.doesNotMatch(await exported.text(),/diagnostic-test-only/);
});
test('browser logs cap bytes and ignore body, URLs, tokens and thrown messages',async()=>{
 const memory=new Map();globalThis.localStorage={getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v)};
 const {recordDiagnostic,browserDiagnostics,MAX_CLIENT_LOG_BYTES}=await import('../web/js/diagnostics.js?test');
 for(let i=0;i<1200;i++)recordDiagnostic('request.done',{count:i,body:'NOTE PRIVATE',url:'https://host?q=PASSWORD',token:'secret',error:new Error('SENSITIVE')});
 const output=browserDiagnostics();assert.doesNotMatch(output,/PRIVATE|PASSWORD|SENSITIVE|secret/);assert.ok(Buffer.byteLength(memory.get('nb-diagnostics-v1'))<=MAX_CLIENT_LOG_BYTES);assert.equal(output.trim().split('\n').length,200);
 delete globalThis.localStorage;
 assert.doesNotThrow(()=>recordDiagnostic('save.failed',{error:new Error('storage missing')}));
});
