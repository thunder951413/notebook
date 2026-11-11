import type { Page } from '@notebook/domain'
import { NotebookRendererDatabase } from './database'
import { SearchCache, type SearchHit, type SearchIndex } from './search'

type Query = { id: number; workspaceId: string; query: string; limit?: number }
export type SearchWorkerRequest =
  | { type: 'init'; dbName: string }
  | { type: 'close' }
  | { type: 'abort'; id: number }
  | { type: 'upsert'; page: Page; text?: string }
  | { type: 'remove'; workspaceId: string; pageId: string }
  | { type: 'invalidate'; workspaceId: string }
  | { type: 'refresh'; workspaceId: string; pageIds: string[] }
  | ({ type: 'search' | 'candidates' | 'hits' } & Query)
export type SearchWorkerResponse = { id: number; result?: unknown; error?: string }

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; retry: () => Promise<unknown> }

/**
 * Full-text search with the index in a Web Worker. Building the index over a
 * large library takes tens of seconds in WebKit; on the window's thread that
 * froze typing (Cmd+P, the note list). Messages reach the worker in the order
 * they are sent, so a search always sees the edits made before it.
 *
 * If the worker cannot start, everything falls back to an index on this
 * thread, and requests that were waiting are answered from it.
 */
export class WorkerSearchIndex implements SearchIndex {
  private worker: Worker | undefined
  private fallback: SearchCache | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly db: NotebookRendererDatabase, createWorker: () => Worker) {
    try {
      this.worker = createWorker()
      this.worker.addEventListener('message', (event: MessageEvent<SearchWorkerResponse>) => {
        const request = this.pending.get(event.data.id)
        if (!request) return
        this.pending.delete(event.data.id)
        if (event.data.error !== undefined) request.reject(new Error(event.data.error))
        else request.resolve(event.data.result)
      })
      this.worker.addEventListener('error', (event) => { event.preventDefault(); this.useFallback() })
      this.post({ type: 'init', dbName: db.name })
    } catch {
      this.useFallback()
    }
  }

  private local() {
    this.fallback ??= new SearchCache()
    return this.fallback
  }

  private useFallback() {
    this.worker?.terminate()
    this.worker = undefined
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const request of waiting) void request.retry().then(request.resolve, request.reject)
  }

  private post(message: SearchWorkerRequest) {
    this.worker?.postMessage(message)
  }

  private request<T>(type: 'search' | 'candidates' | 'hits', workspaceId: string, query: string, limit: number | undefined, retry: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!this.worker) return retry()
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      // A superseded query is answered as aborted at once and cancelled in the
      // worker; any late worker reply is dropped.
      const onAbort = () => {
        this.pending.delete(id)
        this.post({ type: 'abort', id })
        reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const done = <V>(settle: (value: V) => void) => (value: V) => { signal?.removeEventListener('abort', onAbort); settle(value) }
      this.pending.set(id, { resolve: done(resolve as (value: unknown) => void), reject: done(reject), retry })
      this.post({ type, id, workspaceId, query, limit })
    })
  }

  upsert(page: Page, text?: string) {
    if (this.worker) this.post({ type: 'upsert', page, text })
    else this.local().upsert(page, text)
  }

  remove(workspaceId: string, pageId: string) {
    if (this.worker) this.post({ type: 'remove', workspaceId, pageId })
    else this.local().remove(workspaceId, pageId)
  }

  async refresh(workspaceId: string, pageIds: Iterable<string>, db: NotebookRendererDatabase) {
    if (this.worker) this.post({ type: 'refresh', workspaceId, pageIds: [...new Set(pageIds)] })
    else await this.local().refresh(workspaceId, pageIds, db)
  }

  invalidate(workspaceId: string) {
    if (this.worker) this.post({ type: 'invalidate', workspaceId })
    else this.local().invalidate(workspaceId)
  }

  close() {
    if (this.worker) {
      this.post({ type: 'close' })
      this.worker.terminate()
      this.worker = undefined
    }
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const request of waiting) {
      request.reject(new DOMException('Aborted', 'AbortError'))
    }
    this.fallback?.close()
    this.fallback = undefined
  }

  search(db: NotebookRendererDatabase, workspaceId: string, query: string, limit?: number, signal?: AbortSignal) {
    return this.request<Page[]>('search', workspaceId, query, limit, () => this.local().search(db, workspaceId, query, limit, signal), signal)
  }

  candidates(db: NotebookRendererDatabase, workspaceId: string, query: string, limit?: number) {
    return this.request<Page[]>('candidates', workspaceId, query, limit, () => this.local().candidates(db, workspaceId, query, limit))
  }

  hits(db: NotebookRendererDatabase, workspaceId: string, query: string, limit?: number, signal?: AbortSignal) {
    return this.request<SearchHit[]>('hits', workspaceId, query, limit, () => this.local().hits(db, workspaceId, query, limit, signal), signal)
  }
}

/**
 * The worker side: an index on the worker's thread over its own connection to
 * the same IndexedDB database, fed every edit the window makes as a message.
 * Operations run through a serial promise queue so an async `refresh` finishes
 * reading IndexedDB before subsequent queries or mutations run, while `abort`
 * and `close` preempt in-flight work immediately on message arrival.
 */
export function createSearchWorkerHandler(reply: (message: SearchWorkerResponse) => void) {
  const cache = new SearchCache()
  let db: NotebookRendererDatabase | undefined
  let closed = false
  let queue = Promise.resolve()
  const controllers = new Map<number, AbortController>()
  const abortedIds = new Set<number>()

  const enqueue = (task: () => Promise<void> | void) => {
    const next = queue.then(task)
    queue = next.catch(() => {})
  }

  return (message: SearchWorkerRequest) => {
    if (message.type === 'abort') {
      const controller = controllers.get(message.id)
      if (controller) {
        controllers.delete(message.id)
        controller.abort()
      } else {
        abortedIds.add(message.id)
        if (abortedIds.size > 1024) abortedIds.delete(abortedIds.values().next().value!)
      }
      return
    }
    if (message.type === 'close') {
      closed = true
      for (const controller of controllers.values()) controller.abort()
      controllers.clear()
      abortedIds.clear()
      cache.close()
      db?.close()
      db = undefined
      return
    }
    if (message.type === 'search' || message.type === 'candidates' || message.type === 'hits') {
      if (abortedIds.delete(message.id)) {
        reply({ id: message.id, error: 'Aborted' })
        return
      }
      const controller = new AbortController()
      controllers.set(message.id, controller)
      enqueue(async () => {
        try {
          if (closed || abortedIds.delete(message.id) || controller.signal.aborted) {
            reply({ id: message.id, error: 'Aborted' })
            return
          }
          if (!db) {
            reply({ id: message.id, error: 'search worker was not initialised' })
            return
          }
          const result = message.type === 'search'
            ? await cache.search(db, message.workspaceId, message.query, message.limit, controller.signal)
            : message.type === 'candidates'
              ? await cache.candidates(db, message.workspaceId, message.query, message.limit)
              : await cache.hits(db, message.workspaceId, message.query, message.limit, controller.signal)
          if (!closed) reply({ id: message.id, result })
        } catch (error: unknown) {
          if (!closed) reply({ id: message.id, error: error instanceof Error ? error.message : String(error) })
        } finally {
          controllers.delete(message.id)
        }
      })
      return
    }
    enqueue(async () => {
      if (message.type === 'init') {
        closed = false
        db?.close()
        db = new NotebookRendererDatabase(message.dbName)
        return
      }
      if (closed) return
      if (message.type === 'upsert') { cache.upsert(message.page, message.text); return }
      if (message.type === 'remove') { cache.remove(message.workspaceId, message.pageId); return }
      if (message.type === 'invalidate') { cache.invalidate(message.workspaceId); return }
      if (!db) return
      if (message.type === 'refresh') {
        await cache.refresh(message.workspaceId, message.pageIds, db).catch(() => cache.invalidate(message.workspaceId))
      }
    })
  }
}

/** The worker-backed index where Web Workers exist (the app), else one on this thread (tests, tools). */
export function createSearchIndex(db: NotebookRendererDatabase): SearchIndex {
  if (typeof Worker === 'undefined') return new SearchCache()
  return new WorkerSearchIndex(db, () => new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' }))
}
