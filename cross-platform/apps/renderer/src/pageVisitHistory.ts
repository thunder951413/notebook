export interface PageVisitHistory {
  entries: string[]
  index: number
}

export const emptyPageVisitHistory = (): PageVisitHistory => ({ entries: [], index: -1 })

export function recordPageVisit(history: PageVisitHistory, pageId: string, limit = 100): PageVisitHistory {
  if (!pageId || history.entries[history.index] === pageId) return history
  const entries = [...history.entries.slice(0, history.index + 1), pageId].slice(-limit)
  return { entries, index: entries.length - 1 }
}

export function pageVisitTarget(
  history: PageVisitHistory,
  direction: -1 | 1,
  isAvailable: (pageId: string) => boolean,
): { history: PageVisitHistory; pageId?: string } {
  for (let index = history.index + direction; index >= 0 && index < history.entries.length; index += direction) {
    const pageId = history.entries[index]!
    if (isAvailable(pageId)) return { history: { ...history, index }, pageId }
  }
  return { history }
}
