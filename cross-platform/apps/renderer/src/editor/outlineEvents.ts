export const OUTLINE_JUMP_EVENT = 'notebook:outline-jump'
export const OUTLINE_ACTIVE_EVENT = 'notebook:outline-active'

type ActiveHeading = { pageId: string; index: number }
let latest: ActiveHeading | undefined
let lockedUntil = 0

/** Where the reader's eye is: a little below the top of the scroll area. */
export function outlineProbe(top: number, height: number) {
  return top + Math.max(40, Math.min(160, height * 0.2))
}

/** Index of the last element (in document order) whose top is at or above `probe`; -1 when none is. */
export function lastHeadingAbove(count: number, topOf: (index: number) => number, probe: number) {
  let low = -1
  let high = count - 1
  while (low < high) {
    const middle = (low + high + 1) >>> 1
    if (topOf(middle) <= probe) low = middle
    else high = middle - 1
  }
  return low
}

function publish(next: ActiveHeading) {
  if (latest?.pageId === next.pageId && latest.index === next.index) return
  latest = next
  window.dispatchEvent(new CustomEvent<ActiveHeading>(OUTLINE_ACTIVE_EVENT, { detail: next }))
}

/** The heading the reading position is in, reported by the editor or reader while it scrolls. */
export function reportActiveHeading(pageId: string, index: number) {
  if (performance.now() < lockedUntil) return
  publish({ pageId, index })
}

/** An outline click: show that heading as current while the jump's own scrolling settles. */
export function selectActiveHeading(pageId: string, index: number) {
  lockedUntil = performance.now() + 900
  publish({ pageId, index })
}

export function activeHeadingOf(pageId: string) {
  return latest?.pageId === pageId ? latest.index : -1
}
