import 'fake-indexeddb/auto'
import { afterEach, expect, test, vi } from 'vitest'
import type { Page } from '@notebook/domain'
import { DexieNotebookRepository, NotebookRendererDatabase } from './index'
import { SEARCH_INDEX_CHUNK_SIZE, SearchCache, type SearchIndex } from './search'
import { createSearchWorkerHandler, WorkerSearchIndex, type SearchWorkerRequest, type SearchWorkerResponse } from './searchWorker'

const opened: NotebookRendererDatabase[] = []
const indices: SearchIndex[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const index of indices.splice(0)) index.close()
  await Promise.all(opened.splice(0).map(async (db) => { db.close(); await db.delete() }))
})

const trackIndex = <T extends SearchIndex>(index: T): T => {
  indices.push(index)
  return index
}

const page = (id: string, title: string): Page => ({
  id, workspaceId: 'workspace-a', sectionId: 'section-a', kind: 'document', title, preview: '', favorite: false,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', syncStatus: 'local',
})

async function library() {
  const db = new NotebookRendererDatabase(`search-worker-${crypto.randomUUID()}`)
  opened.push(db)
  const repository = new DexieNotebookRepository(db)
  await repository.savePage(page('alpha', 'Alpha'), { pageId: 'alpha', schemaVersion: 1, markdown: 'notes about lighthouses', tiptapJson: { type: 'doc', content: [] }, updatedAt: '2026-01-02T00:00:00.000Z' })
  await repository.savePage(page('beta', 'Beta'))
  return db
}

/** Runs the real worker handler asynchronously, with structured-cloned messages, like a Worker. */
class FakeWorker {
  private readonly listeners = { message: [] as Array<(event: MessageEvent<SearchWorkerResponse>) => void>, error: [] as Array<(event: ErrorEvent) => void> }
  readonly received: SearchWorkerRequest[] = []
  terminated = false
  private readonly handle = createSearchWorkerHandler((message) => setTimeout(() => this.listeners.message.forEach((listener) => listener({ data: structuredClone(message) } as MessageEvent<SearchWorkerResponse>)), 0))
  addEventListener(type: 'message' | 'error', listener: never) { (this.listeners[type] as unknown[]).push(listener) }
  postMessage(message: SearchWorkerRequest) {
    this.received.push(message)
    const copy = structuredClone(message)
    if (copy.type === 'close') {
      this.handle(copy)
      return
    }
    setTimeout(() => this.handle(copy), 0)
  }
  fail() { this.listeners.error.forEach((listener) => listener({ preventDefault() {} } as ErrorEvent)) }
  terminate() { this.terminated = true }
}

const ids = (pages: Array<{ id: string }>) => pages.map((item) => item.id)

test('searches run in the worker and see the edits sent before them', async () => {
  const db = await library()
  const worker = new FakeWorker()
  const index = trackIndex(new WorkerSearchIndex(db, () => worker as unknown as Worker))
  expect(ids(await index.search(db, 'workspace-a', 'lighthouses'))).toEqual(['alpha'])
  index.upsert(page('beta', 'Beta about lighthouses'), 'no body')
  expect(ids(await index.search(db, 'workspace-a', 'lighthouses')).sort()).toEqual(['alpha', 'beta'])
  index.remove('workspace-a', 'alpha')
  expect(ids(await index.candidates(db, 'workspace-a', 'lighthouses'))).toEqual(['beta'])
  expect((await index.hits(db, 'workspace-a', 'lighthouses')).map((hit) => hit.page.id)).toEqual(['beta'])
  expect(worker.received[0]).toEqual({ type: 'init', dbName: db.name })
})

test('a superseded search is rejected at once and posts abort to cancel in-flight worker work', async () => {
  const db = await library()
  for (let i = 0; i < SEARCH_INDEX_CHUNK_SIZE * 3; i += 1) {
    const id = `extra-${i}`
    await db.pages.put(page(id, `Extra ${i}`))
    await db.documents.put({ pageId: id, schemaVersion: 3, markdown: `harbor entry ${i}`, tiptapJson: { type: 'doc', content: [] }, updatedAt: '2026-01-02T00:00:00.000Z' })
  }
  const worker = new FakeWorker()
  const index = trackIndex(new WorkerSearchIndex(db, () => worker as unknown as Worker))
  // Warm up the worker index so the subsequent query exercises chunked search cancellation.
  expect(ids(await index.search(db, 'workspace-a', 'lighthouses'))).toEqual(['alpha'])

  const originalSearch = SearchCache.prototype.search
  let workerStarted!: () => void
  const started = new Promise<void>((resolve) => { workerStarted = resolve })
  let workerOutcome: 'resolved' | 'aborted' | undefined
  vi.spyOn(SearchCache.prototype, 'search').mockImplementationOnce(async function (this: SearchCache, ...args) {
    workerStarted()
    try {
      const result = await originalSearch.apply(this, args)
      workerOutcome = 'resolved'
      return result
    } catch (error) {
      workerOutcome = 'aborted'
      throw error
    }
  })

  const controller = new AbortController()
  const search = index.search(db, 'workspace-a', 'lighthouses', 50, controller.signal)
  await started
  controller.abort()
  await expect(search).rejects.toThrow()

  const searchMsg = worker.received.find((msg): msg is SearchWorkerRequest & { id: number } => msg.type === 'search' && msg.id > 1)
  expect(searchMsg).toBeDefined()
  expect(worker.received).toContainEqual({ type: 'abort', id: searchMsg!.id })

  // A follow-up search runs cleanly after the aborted worker search settles.
  expect(ids(await index.search(db, 'workspace-a', 'lighthouses'))).toEqual(['alpha'])
  expect(workerOutcome).toBe('aborted')
})

test('a search sent immediately after refresh waits for the refreshed DB content', async () => {
  const db = await library()
  const worker = new FakeWorker()
  const index = trackIndex(new WorkerSearchIndex(db, () => worker as unknown as Worker))
  expect(ids(await index.search(db, 'workspace-a', 'lighthouses'))).toEqual(['alpha'])

  // Simulate a sync write directly to IndexedDB (without calling index.upsert).
  await db.pages.put(page('gamma', 'Gamma'))
  await db.documents.put({
    pageId: 'gamma',
    schemaVersion: 3,
    markdown: 'submarines and periscopes',
    tiptapJson: { type: 'doc', content: [] },
    updatedAt: '2026-01-03T00:00:00.000Z',
  })

  const originalRefresh = SearchCache.prototype.refresh
  vi.spyOn(SearchCache.prototype, 'refresh').mockImplementationOnce(async function (this: SearchCache, ...args) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    return originalRefresh.apply(this, args)
  })

  void index.refresh('workspace-a', ['gamma'], db)
  expect(ids(await index.search(db, 'workspace-a', 'periscopes'))).toEqual(['gamma'])

  // Also verify the local SearchCache fallback guards concurrent searches during refresh.
  const local = trackIndex(new SearchCache())
  expect(ids(await local.search(db, 'workspace-a', 'lighthouses'))).toEqual(['alpha'])
  await db.pages.put(page('delta', 'Delta'))
  await db.documents.put({
    pageId: 'delta',
    schemaVersion: 3,
    markdown: 'observatory telescopes',
    tiptapJson: { type: 'doc', content: [] },
    updatedAt: '2026-01-04T00:00:00.000Z',
  })
  const refreshing = local.refresh('workspace-a', ['delta'], db)
  const concurrentSearch = local.search(db, 'workspace-a', 'telescopes')
  expect(ids(await concurrentSearch)).toEqual(['delta'])
  await refreshing
})

test('close terminates the worker and cleans up repository resources', async () => {
  const db = await library()
  const worker = new FakeWorker()
  const index = new WorkerSearchIndex(db, () => worker as unknown as Worker)
  expect(ids(await index.search(db, 'workspace-a', 'lighthouses'))).toEqual(['alpha'])
  index.close()
  expect(worker.terminated).toBe(true)
  expect(worker.received).toContainEqual({ type: 'close' })
})

test('falls back to searching on this thread when the worker cannot start or fails', async () => {
  const db = await library()
  const unavailable = trackIndex(new WorkerSearchIndex(db, () => { throw new Error('no workers here') }))
  expect(ids(await unavailable.search(db, 'workspace-a', 'lighthouses'))).toEqual(['alpha'])

  const worker = new FakeWorker()
  worker.postMessage = () => {} // the worker never answers…
  const failing = trackIndex(new WorkerSearchIndex(db, () => worker as unknown as Worker))
  const waiting = failing.search(db, 'workspace-a', 'lighthouses')
  worker.fail() // …and then dies: the waiting search is answered here.
  expect(ids(await waiting)).toEqual(['alpha'])
})

test('edits made while the index is building are applied instead of restarting the build', async () => {
  const db = await library()
  const cache = trackIndex(new SearchCache())
  const fullReads = vi.spyOn(db.documents, 'toArray')
  const building = cache.search(db, 'workspace-a', 'lighthouses')
  cache.upsert(page('gamma', 'Gamma'), 'lighthouses again')
  cache.remove('workspace-a', 'alpha')
  // Applied as soon as the build is done, so even the search that waited for it sees them.
  expect(ids(await building)).toEqual(['gamma'])
  expect(ids(await cache.search(db, 'workspace-a', 'lighthouses'))).toEqual(['gamma'])
  expect(fullReads).toHaveBeenCalledTimes(1)
})
