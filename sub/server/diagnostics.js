import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const LOG_FILE_BYTES = 512 * 1024;
export const LOG_FILES = 4;
const MAX_PENDING = 128;
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'HttpError']);
const ERROR_CODES = new Set(['ENOENT','EACCES','EPERM','ENOSPC','EIO','EMFILE','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','conflict','locked','login','invalid_backup','workspace_not_empty']);
export function errorDetails(error) {
  return {
    errorType: ERROR_NAMES.has(error?.name) ? error.name : 'Error',
    ...(ERROR_CODES.has(error?.code || error?.extra?.code) ? { errorCode: error.code || error.extra.code } : {}),
    // Only source filenames and numeric positions, never exception messages or paths.
    frames: String(error?.stack || '').split('\n').slice(1, 7).flatMap(line => {
      const match = line.match(/(?:\/|\\)([A-Za-z0-9_-]+\.(?:m?js|ts)):(\d+):(\d+)/);
      return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
    }),
  };
}
export const resourceRef = value => typeof value === 'string' ? createHash('sha256').update(value).digest('hex').slice(0,12) : undefined;
const token = (v, max=80) => typeof v === 'string' && /^[A-Za-z0-9._:/-]+$/.test(v) ? v.slice(0,max) : undefined;
const uuid = v => typeof v === 'string' && /^[a-f0-9-]{36}$/i.test(v) ? v : undefined;

export function createDiagnostics(dir, { maxBytes=LOG_FILE_BYTES, files=LOG_FILES, now=Date.now }={}) {
  const sessionId=randomUUID();
  let pending=0, dropped=0, tail=Promise.resolve(), closed=false;
  let suppressed=0;
  const recent=new Map();
  const active=path.join(dir,'events.jsonl');
  async function write(entry) {
    await fs.mkdir(dir,{recursive:true,mode:0o700});
    const line=JSON.stringify(entry)+'\n';
    let size=0;try {size=(await fs.stat(active)).size;}catch(error){if(error.code!=='ENOENT')throw error;}
    if(size+Buffer.byteLength(line)>maxBytes) {
      await fs.rm(`${active}.${files-1}`,{force:true});
      for(let i=files-2;i>=0;i--){try{await fs.rename(i?`${active}.${i}`:active,`${active}.${i+1}`);}catch(error){if(error.code!=='ENOENT')throw error;}}
    }
    await fs.appendFile(active,line,{mode:0o600});
  }
  function record(event, details={}) {
    if(closed)return Promise.resolve();
    // Only explicitly allowed metadata is persisted. Never spread caller payloads.
    const entry={timestamp:new Date(now()).toISOString(),sessionId,version:'1.0.0',runtime:process.version,
      event:token(event)||'unknown',level:['info','warning','error'].includes(details.level)?details.level:'info'};
    for(const field of ['operationId']) if(uuid(details[field]))entry[field]=details[field];
    if(token(details.route))entry.route=token(details.route);
    if(['GET','POST','PUT','PATCH','DELETE'].includes(details.method))entry.method=details.method;
    if(/^[a-f0-9]{12}$/.test(details.resourceRef||''))entry.resourceRef=details.resourceRef;
    for(const field of ['status','durationMs','count'])if(Number.isFinite(details[field]))entry[field]=Math.max(0,Math.round(details[field]));
    if(details.error)Object.assign(entry,errorDetails(details.error));
    // Collapse repeated errors for 30s. Fixed-size index prevents cardinality leaks.
    const key=[entry.event,entry.route,entry.status,entry.errorType,entry.errorCode].join('|');
    if(entry.level!=='info') {
      const prior=recent.get(key);
      if(prior&&now()-prior<30000){suppressed++;return Promise.resolve();}
      recent.set(key,now());if(recent.size>128)recent.delete(recent.keys().next().value);
    }
    if(pending>=MAX_PENDING){dropped++;return Promise.resolve();}
    if(suppressed){entry.suppressedSinceLast=suppressed;suppressed=0;}
    if(dropped){entry.droppedSinceLast=dropped;dropped=0;}
    pending++;
    const work=tail.then(()=>write(entry)).catch(()=>{dropped++;}).finally(()=>{pending--;});
    tail=work;
    return work;
  }
  async function flush(){await tail;}
  async function exportLogs(){
    // Snapshot on the same queue as rotation to avoid duplicated/missing files.
    const snapshot=tail.then(async()=>{
      const chunks=[];
      for(let i=files-1;i>=0;i--){try{chunks.push(await fs.readFile(i?`${active}.${i}`:active));}catch(error){if(error.code!=='ENOENT')throw error;}}
      return Buffer.concat(chunks);
    });
    tail=snapshot.then(()=>{},()=>{});
    return snapshot;
  }
  async function close(){
    if(dropped||suppressed)await record('diagnostics.summary');
    closed=true;await flush();
  }
  return {record,flush,close,exportLogs,sessionId,path:active};
}
