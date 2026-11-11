/// <reference lib="webworker" />
import { createSearchWorkerHandler, type SearchWorkerRequest } from './searchWorker'

/** Holds the full-text index off the main thread; see `WorkerSearchIndex`. */
const handle = createSearchWorkerHandler((message) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(message))
self.addEventListener('message', (event: MessageEvent<SearchWorkerRequest>) => handle(event.data))
