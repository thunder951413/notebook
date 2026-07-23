export type FlushHandler = () => void | Promise<void>

const handlers = new Set<FlushHandler>()

export function registerFlushHandler(handler: FlushHandler) {
  handlers.add(handler)
  return () => { handlers.delete(handler) }
}

export async function flushPendingEdits() {
  await Promise.all([...handlers].map((handler) => handler()))
}
