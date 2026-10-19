import { expect, test } from 'vitest'
import { indexLargeMarkdown } from '../data/largeDocumentIndex'
import { anchorAtProbe, scrollTopForAnchor, type BlockBox } from './readingAnchor'

const source = Array.from({ length: 60 }, (_, index) => `# 第 ${index} 章\n\n${'正文一段。\n\n'.repeat(900)}`).join('')
const index = indexLargeMarkdown(source)
// Every block is 1,000px tall and the reading area is scrolled to `scroll`.
const layout = (scroll: number) => (chunk: number): BlockBox | undefined => chunk < index.chunks.length ? { top: chunk * 1000 - scroll, height: 1000 } : undefined

test('the anchor is the offset of the line at the top of the reading area', () => {
  const start = index.chunks[10]!
  const middle = anchorAtProbe(index, layout(10_000 + 500))
  expect(middle).toBeGreaterThan(start.start)
  expect(middle).toBeLessThan(start.end)
  expect(anchorAtProbe(index, layout(10_000))).toBe(start.start)
  expect(anchorAtProbe(index, layout(0))).toBe(0)
})

test('scrolling to an anchor lands on the same line the anchor was read from', () => {
  for (const scroll of [0, 3_250, 17_999, 41_500]) {
    const anchor = anchorAtProbe(index, layout(scroll))
    expect(scrollTopForAnchor(index, anchor, (chunk) => ({ ...layout(0)(chunk)! }))).toBeCloseTo(scroll, -2)
  }
})

test('a chunk that has no box yet does not break the lookup', () => {
  expect(anchorAtProbe(index, () => undefined)).toBe(0)
  expect(scrollTopForAnchor(index, 5, () => undefined)).toBeUndefined()
})
