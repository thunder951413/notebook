import test from 'node:test';
import assert from 'node:assert/strict';
import { createSaveQueue } from '../web/js/save-queue.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(t,save,storageOverride) {
  const map=new Map();const storage=storageOverride || {getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
  const queue=createSaveQueue({save,storage,delay:60000});t.after(()=>queue.dispose());
  queue.register({id:'a',title:'A',updatedAt:'v1'});queue.register({id:'b',title:'B',updatedAt:'v1'});
  return {queue,map};
}
test('slow saves drain newer edits and only clear the acknowledged page draft',async t=>{
 const first=deferred(),second=deferred(),calls=[];
 const {queue,map}=fixture(t,async(id,patch)=>{calls.push({id,patch});return calls.length===1?first.promise:second.promise;});
 queue.enqueue('a',{title:'A',markdown:'first'});const saving=queue.flush('a');await Promise.resolve();
 queue.enqueue('a',{title:'A',markdown:'latest'});queue.enqueue('b',{title:'B',markdown:'other page'});
 first.resolve({id:'a',title:'Derived first',updatedAt:'v2'});await new Promise(r=>setImmediate(r));
 assert.equal(calls.length,2);assert.equal(calls[1].patch.markdown,'latest');assert.equal(calls[1].patch.expectedUpdatedAt,'v2');
 assert.equal('title' in calls[1].patch,false,'stale UI title must not undo heading-derived title');
 assert.equal(JSON.parse(map.get('nb-draft-a')).body,'latest');assert.ok(map.has('nb-draft-b'));
 second.resolve({id:'a',title:'Latest heading',updatedAt:'v3'});await saving;
 assert.equal(map.has('nb-draft-a'),false);assert.equal(map.has('nb-draft-b'),true);
});
test('pages save independently, including navigation before debounce',async t=>{
 const gate=deferred(),seen=[];const {queue}=fixture(t,async(id,p)=>{seen.push(id);if(id==='a')await gate.promise;return {id,title:id,updatedAt:'v2',markdown:p.markdown};});
 queue.enqueue('a',{title:'A',markdown:'a edit'});const a=queue.flush('a');
 queue.enqueue('b',{title:'B',markdown:'b edit'});await queue.flush('b');
 assert.deepEqual(seen,['a','b']);assert.ok(queue.get('a').pending);assert.equal(queue.get('b').pending,null);
 gate.resolve();await a;
});
test('network failure retains complete metadata draft and retries on reconnect',async t=>{
 let offline=true;const {queue,map}=fixture(t,async(id,p)=>{if(offline)throw new TypeError('offline');return {id,title:p.title,updatedAt:'v2'};});
 queue.enqueue('a',{title:'renamed',markdown:'body',kind:'task',dueAt:'2026-09-06T10:00:00Z'});
 await assert.rejects(queue.flush('a'),/offline/);
 assert.equal(JSON.parse(map.get('nb-draft-a')).patch.kind,'task');assert.ok(queue.hasPending());
 offline=false;const results=await queue.retryAll();assert.ok(results.every(r=>r.status==='fulfilled'));assert.equal(queue.hasPending(),false);
});
test('conflicts never authorize overwrite through typing or reconnect',async t=>{
 let calls=0;const conflict=Object.assign(new Error('conflict'),{status:409});const {queue,map}=fixture(t,async()=>{calls++;throw conflict;});
 queue.enqueue('a',{title:'A',markdown:'local'});await assert.rejects(queue.flush('a'),conflict);
 queue.enqueue('a',{title:'A',markdown:'newer local'});await queue.retryAll();
 assert.equal(calls,1);assert.equal(JSON.parse(map.get('nb-draft-a')).body,'newer local');
 queue.discard('a');assert.equal(map.has('nb-draft-a'),false);
});
test('quota errors are visible while in-memory edits still save',async t=>{
 const {queue}=fixture(t,async()=>({id:'a',title:'A',updatedAt:'v2'}),{setItem(){throw new Error('quota');},removeItem(){}});
 queue.enqueue('a',{title:'A',markdown:'must save'});assert.match(queue.get('a').storageError.message,/quota/);
 await queue.flush('a');assert.equal(queue.hasPending(),false);
});
test('explicit title changes survive a newer edit queued during save',async t=>{
 const gate=deferred(),calls=[];const {queue}=fixture(t,async(id,p)=>{calls.push(p);if(calls.length===1)await gate.promise;return {id,title:p.title || 'heading',updatedAt:'v'+(calls.length+1)};});
 queue.enqueue('a',{title:'A',markdown:'# heading'});const saving=queue.flush('a');await Promise.resolve();
 queue.enqueue('a',{title:'My explicit title',markdown:'# heading\nnew'});gate.resolve();await saving;
 assert.equal(calls[1].title,'My explicit title');
});
