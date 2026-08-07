export type FlushHandler = () => void | Promise<void>

const handlers = new Set<FlushHandler>()
const afterFlushHandlers = new Set<FlushHandler>()

export function registerFlushHandler(handler: FlushHandler) {
  handlers.add(handler)
  return () => { handlers.delete(handler) }
}

/** Runs after all durable editor/local-state flushes have settled. */
export function registerAfterFlushHandler(handler: FlushHandler) {
  afterFlushHandlers.add(handler)
  return () => { afterFlushHandlers.delete(handler) }
}

export async function flushPendingEdits() {
  await Promise.all([...handlers].map((handler) => handler()))
  await Promise.all([...afterFlushHandlers].map((handler) => handler()))
}
