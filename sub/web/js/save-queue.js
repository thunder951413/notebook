import {recordDiagnostic} from './diagnostics.js';
// Each request acknowledges only its own page and snapshot. Drafts survive
// navigation, network failures, conflicts and newer edits arriving in flight.
export function createSaveQueue({ save, storage, onChange = () => {}, delay = 900 }) {
  const entries = new Map();
  const key = id => 'nb-draft-' + id;
  const notify = entry => onChange(entry.id, entry);
  function persist(entry) {
    if (!entry.pending) return;
    try {
      storage.setItem(key(entry.id), JSON.stringify({
        version: 2, patch: entry.pending.patch, body: entry.pending.patch.markdown,
        baseUpdatedAt: entry.expectedUpdatedAt, savedAt: new Date().toISOString(),
      }));
      entry.storageError = null;
    } catch (error) { entry.storageError = error;recordDiagnostic('draft.persist.failed',{error}); }
  }
  function register(page) {
    let entry = entries.get(page.id);
    if (!entry) {
      entry = { id: page.id, sequence: 0, pending: null, promise: null, timer: null, error: null };
      entries.set(page.id, entry);
    }
    if (!entry.pending && !entry.promise) {
      entry.expectedUpdatedAt = page.updatedAt;
      entry.baseTitle = page.title;
      entry.baseInputTitle = page.title;
    }
    return entry;
  }
  function enqueue(id, patch) {
    const entry = entries.get(id);
    if (!entry) throw new Error('Page must be loaded before editing');
    entry.pending = { sequence: ++entry.sequence, patch: structuredClone(patch), titleChanged: patch.title !== entry.baseInputTitle };
    // Conflicts require an explicit user decision; typing must never authorize
    // overwriting a newer server version.
    if (entry.error?.status !== 409) entry.error = null;
    persist(entry);
    clearTimeout(entry.timer);
    if (!entry.error) entry.timer = setTimeout(() => { void flush(id).catch(() => {}); }, delay);
    notify(entry);
  }
  function flush(id) {
    const entry = entries.get(id);
    if (!entry) return Promise.resolve();
    clearTimeout(entry.timer);
    if (entry.promise) return entry.promise;
    if (entry.error?.status === 409) return Promise.reject(entry.error);
    if (!entry.pending) return Promise.resolve();
    entry.error = null;
    entry.promise = (async () => {
      // Start after assigning promise so synchronous observers see saving=true.
      await Promise.resolve();
      notify(entry);
      try {
        while (entry.pending) {
          const snapshot = entry.pending;
          const patch = { ...snapshot.patch, expectedUpdatedAt: entry.expectedUpdatedAt };
          if (!snapshot.titleChanged) delete patch.title;
          const updated = await save(id, patch);
          entry.expectedUpdatedAt = updated.updatedAt;
          entry.baseTitle = updated.title;
          entry.saved = updated;
          entry.savedSnapshot = snapshot.patch;
          entry.baseInputTitle = entry.pending.sequence === snapshot.sequence ? updated.title : snapshot.patch.title;
          if (entry.pending.sequence === snapshot.sequence) {
            entry.pending = null;
            try { storage.removeItem(key(id)); } catch { /* duplicate draft is safer than loss */ }
          } else persist(entry);
          notify(entry);
        }
      } catch (error) {
        entry.error = error;
        recordDiagnostic(error.status===409?'save.conflict':'save.failed',{error,status:error.status,operationId:error.operationId});
        persist(entry);
        throw error;
      } finally {
        entry.promise = null;
        notify(entry);
      }
    })();
    return entry.promise;
  }
  return {
    register, enqueue, flush,
    get: id => entries.get(id),
    retryAll: () => Promise.allSettled([...entries.keys()].map(flush)),
    persistAll: () => entries.forEach(persist),
    hasPending: () => [...entries.values()].some(entry => entry.pending),
    // Only used after the user explicitly chooses the server version.
    discard(id) {
      const entry = entries.get(id);
      if (entry?.promise) throw new Error('请等待当前保存结束');
      clearTimeout(entry?.timer);
      entries.delete(id);
      storage.removeItem(key(id));
    },
    dispose() { entries.forEach(entry => clearTimeout(entry.timer)); },
  };
}
