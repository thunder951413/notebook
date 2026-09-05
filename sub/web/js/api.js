import {recordDiagnostic,diagnosticId} from './diagnostics.js';
// Minimal fetch client for the notebook server REST API.
export class ApiError extends Error {
  constructor(status, message, code, operationId) {
    super(message);
    this.name='ApiError';
    this.status = status;
    this.code = code;
    this.operationId = operationId;
  }
}

async function request(method, path, body, isForm) {
  const operationId=diagnosticId();
  const start=performance.now();
  const opts = { method, headers: {'X-Request-Id':operationId}, credentials: 'same-origin' };
  if (body !== undefined) {
    if (isForm) {
      opts.body = body; // FormData
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const controller = new AbortController();
  opts.signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), 20000);
  let res;
  try { res = await fetch(path, opts); } catch(error) {recordDiagnostic('request.failed',{operationId,method,error,durationMs:performance.now()-start});throw error;} finally { clearTimeout(timer); }
  if(method!=='GET'||!res.ok||performance.now()-start>1000)recordDiagnostic(res.ok?'request.done':'request.failed',{operationId,method,status:res.status,durationMs:performance.now()-start});
  try {
  if (res.status === 401) {
    let info = {};
    try { info = await res.json(); } catch {}
    if (info.code === 'login') {
      window.dispatchEvent(new CustomEvent('nb:login-required'));
    }
    throw new ApiError(res.status, info.error || 'unauthorized', info.code,operationId);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const data = await res.json();
    if (!res.ok) throw new ApiError(res.status, data.error || 'request failed', data.code,operationId);
    return data;
  }
  if (!res.ok) throw new ApiError(res.status, 'request failed',undefined,operationId);
  return res;
  } catch(error) {recordDiagnostic('response.failed',{operationId,method,status:res.status,error,durationMs:performance.now()-start});throw error;}
}

export const api = {
  get: (path, params) => {
    const clean = params ? Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')) : null;
    const q = clean ? '?' + new URLSearchParams(clean).toString() : '';
    return request('GET', path + q);
  },
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  patch: (path, body) => request('PATCH', path, body),
  restoreBackup: (file) => { const fd = new FormData();fd.append('file',file,file.name);return request('POST','/api/backup/restore',fd,true); },
  del: (path) => request('DELETE', path),
  upload: (pageId, file, extra = {}) => {
    const fd = new FormData();
    fd.append('pageId', pageId);
    fd.append('file', file, file.name);
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined && v !== null) fd.append(k, String(v));
    }
    return request('POST', '/api/upload', fd, true);
  },
  importFiles: (notebookId, files) => {
    const fd = new FormData();
    fd.append('notebookId', notebookId);
    for (const f of files) fd.append('file', f, f.name);
    return request('POST', '/api/import', fd, true);
  },
};

export function assetUrl(assetId) {
  return '/api/assets/' + encodeURIComponent(assetId) + '/data';
}

window.API = api;
window.ApiError = ApiError;
window.assetUrl = assetUrl;
