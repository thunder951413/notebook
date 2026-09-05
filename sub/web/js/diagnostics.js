// Local browser ring: allowlisted metadata only. Independent from note drafts.
const KEY='nb-diagnostics-v1';
export const MAX_CLIENT_LOG_BYTES=256*1024;
const MAX_ENTRIES=200;
export function diagnosticId(){
  if(typeof globalThis.crypto?.randomUUID==='function')return globalThis.crypto.randomUUID();
  // LAN HTTP pages may lack randomUUID; these IDs are for correlation, not auth.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const n=Math.floor(Math.random()*16);return (c==='x'?n:(n&3)|8).toString(16);});
}
const sessionId=diagnosticId();
let entries=[];
try {const previous=JSON.parse(localStorage.getItem(KEY)||'[]');if(Array.isArray(previous))entries=previous.slice(-MAX_ENTRIES);}catch{}
const recent=new Map();
let suppressed=0;
const knownErrors=new Set(['Error','ApiError','AbortError','TypeError','SyntaxError','QuotaExceededError','SecurityError']);
export function recordDiagnostic(event,details={}) {
  try {
    const entry={timestamp:new Date().toISOString(),sessionId,version:'1.0.0',event};
    if(!/^[a-z][a-z._-]{0,63}$/.test(event))return;
    if(/^[a-f0-9-]{36}$/i.test(details.operationId||''))entry.operationId=details.operationId;
    if(['GET','POST','PUT','PATCH','DELETE'].includes(details.method))entry.method=details.method;
    for(const field of ['status','durationMs','count'])if(Number.isFinite(details[field]))entry[field]=Math.max(0,Math.round(details[field]));
    if(details.error){
      entry.errorType=knownErrors.has(details.error.name)?details.error.name:'Error';
      entry.frames=String(details.error.stack||'').split('\n').slice(1,7).flatMap(line=>{const m=line.match(/\/([A-Za-z0-9_-]+\.m?js):(\d+):(\d+)/);return m?[m[1]+':'+m[2]+':'+m[3]]:[];});
    }
    const signature=[event,entry.status,entry.errorType].join('|');
    if(event.includes('failed')||event.includes('error')){
      if(Date.now()-(recent.get(signature)||0)<30000){suppressed++;return;}
      recent.set(signature,Date.now());if(recent.size>64)recent.delete(recent.keys().next().value);
    }
    if(suppressed){entry.suppressedSinceLast=suppressed;suppressed=0;}
    entries.push(entry);entries=entries.slice(-MAX_ENTRIES);
    let json=JSON.stringify(entries);
    while(new TextEncoder().encode(json).length>MAX_CLIENT_LOG_BYTES){entries.shift();json=JSON.stringify(entries);}
    try{localStorage.setItem(KEY,json);}catch{/* Keep the bounded in-memory ring when storage is full. */}
  }catch{/* Diagnostics must not affect editing. */}
}
export function browserDiagnostics(){return entries.map(entry=>JSON.stringify(entry)).join('\n')+'\n';}
export function downloadBrowserDiagnostics(){
  const url=URL.createObjectURL(new Blob([browserDiagnostics()],{type:'application/x-ndjson'}));
  const a=document.createElement('a');a.href=url;a.download='notebook-browser-diagnostics.jsonl';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function installDiagnostics(){
  recordDiagnostic('app.start');
  window.addEventListener('error',e=>recordDiagnostic('app.error',{error:e.error}));
  window.addEventListener('unhandledrejection',e=>recordDiagnostic('app.rejection',{error:e.reason}));
  window.addEventListener('online',()=>recordDiagnostic('network.online'));
  window.addEventListener('offline',()=>recordDiagnostic('network.offline'));
}
