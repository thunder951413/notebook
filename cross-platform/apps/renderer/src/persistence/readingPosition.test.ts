import { expect, test } from 'vitest'
import type { ReadingPosition } from '@notebook/domain'
import { chooseReadingPosition, syncedViewportPosition } from './readingPosition'
import { readLocalReadingPositions, writeLocalReadingPositions } from './localLayout'

const remote = (patch: Partial<ReadingPosition> = {}): ReadingPosition => ({ id: 'p', pageId: 'p', anchorUtf16Offset: 120_000, viewportOffsetFraction: 0.4, updatedAt: '2026-10-19T12:00:00.000Z', deviceId: 'phone', ...patch })

test('a position another device published after the local one wins', () => {
  const chosen = chooseReadingPosition({ fraction: 0.1, scrollTop: 900, updatedAt: '2026-10-19T10:00:00.000Z' }, remote(), 'desktop')
  expect(chosen).toEqual({ fraction: 0.4, anchor: 120_000, updatedAt: '2026-10-19T12:00:00.000Z' })
})

test('the local position wins when it is newer, or the record came from this device', () => {
  const local = { fraction: 0.1, scrollTop: 900, updatedAt: '2026-10-19T13:00:00.000Z' }
  expect(chooseReadingPosition(local, remote(), 'desktop')).toBe(local)
  expect(chooseReadingPosition({ ...local, updatedAt: '2026-10-19T10:00:00.000Z' }, remote({ deviceId: 'desktop' }), 'desktop')).toEqual({ ...local, updatedAt: '2026-10-19T10:00:00.000Z' })
})

test('a local record from before timestamps yields to a record from another device', () => {
  expect(chooseReadingPosition({ fraction: 0.1 }, remote(), 'desktop')?.fraction).toBe(0.4)
})

test('with only one side, that side is used; an unset anchor is not carried', () => {
  expect(chooseReadingPosition(undefined, undefined, 'desktop')).toBeUndefined()
  expect(chooseReadingPosition({ fraction: 0.2 }, undefined, 'desktop')).toEqual({ fraction: 0.2 })
  expect(chooseReadingPosition(undefined, remote({ anchorUtf16Offset: 0 }), 'desktop')).toEqual({ fraction: 0.4, updatedAt: '2026-10-19T12:00:00.000Z' })
  expect(syncedViewportPosition(remote({ viewportOffsetFraction: 7 })).fraction).toBe(1)
})

test('local positions keep their anchor and timestamp across a reload', () => {
  writeLocalReadingPositions(new Map([['a', { fraction: 0.5, scrollTop: 10, anchor: 4242, updatedAt: '2026-10-19T12:00:00.000Z' }], ['b', { fraction: 0.2 }]]))
  const read = readLocalReadingPositions()
  expect(read.a).toEqual({ fraction: 0.5, scrollTop: 10, anchor: 4242, updatedAt: '2026-10-19T12:00:00.000Z' })
  expect(read.b).toEqual({ fraction: 0.2 })
})
