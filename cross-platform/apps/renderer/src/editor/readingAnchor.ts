import { chunkAtOffset, type ReadingIndex } from '../data/largeDocumentIndex'

/** Layout of one reading block relative to the top of the scroll area. */
export interface BlockBox { top: number; height: number }

/** Markdown offset of the line at `probe` pixels below the top of the reading area. */
export function anchorAtProbe(index: ReadingIndex, box: (chunk: number) => BlockBox | undefined, probe = 0) {
  let low = 0
  let high = index.chunks.length - 1
  while (low < high) {
    const middle = (low + high + 1) >>> 1
    const layout = box(middle)
    if (layout && layout.top <= probe) low = middle
    else high = middle - 1
  }
  const chunk = index.chunks[low]
  const layout = box(low)
  if (!chunk || !layout) return 0
  const inside = layout.height > 0 ? Math.max(0, Math.min(1, (probe - layout.top) / layout.height)) : 0
  return chunk.start + Math.round(inside * (chunk.end - chunk.start))
}

/** Pixels from the top of the reading area (its scroll origin) to the line holding `anchor`. */
export function scrollTopForAnchor(index: ReadingIndex, anchor: number, box: (chunk: number) => BlockBox | undefined) {
  const number = chunkAtOffset(index, anchor)
  const chunk = index.chunks[number]
  const layout = box(number)
  if (!chunk || !layout) return undefined
  const inside = chunk.end > chunk.start ? Math.max(0, Math.min(1, (anchor - chunk.start) / (chunk.end - chunk.start))) : 0
  return layout.top + inside * layout.height
}
