import { describe, expect, it } from 'vitest'
import { activeHeadingOf, lastHeadingAbove, reportActiveHeading, selectActiveHeading } from './outlineEvents'

describe('outline position', () => {
  const tops = [100, 400, 900, 1500]
  it('picks the last heading at or above the probe', () => {
    expect(lastHeadingAbove(tops.length, (index) => tops[index]!, 50)).toBe(-1)
    expect(lastHeadingAbove(tops.length, (index) => tops[index]!, 400)).toBe(1)
    expect(lastHeadingAbove(tops.length, (index) => tops[index]!, 1499)).toBe(2)
    expect(lastHeadingAbove(tops.length, (index) => tops[index]!, 5000)).toBe(3)
    expect(lastHeadingAbove(0, () => 0, 10)).toBe(-1)
  })

  it('keeps a clicked heading current while the jump scrolls, then follows scrolling', () => {
    reportActiveHeading('page-a', 1)
    expect(activeHeadingOf('page-a')).toBe(1)
    expect(activeHeadingOf('page-b')).toBe(-1)
    selectActiveHeading('page-a', 3)
    reportActiveHeading('page-a', 2)
    expect(activeHeadingOf('page-a')).toBe(3)
  })
})
