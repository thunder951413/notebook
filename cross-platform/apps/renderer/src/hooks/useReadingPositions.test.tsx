import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { ReadingPosition } from '@notebook/domain'
import { writeLocalReadingPositions } from '../persistence/localLayout'
import { legacyDeviceId } from '../sync/legacySshSettings'
import { useReadingPositions } from './useReadingPositions'

beforeEach(() => localStorage.clear())

const record = (patch: Partial<ReadingPosition> = {}): ReadingPosition => ({ id: 'page', pageId: 'page', anchorUtf16Offset: 90_000, viewportOffsetFraction: 0.6, updatedAt: '2026-10-19T12:00:00.000Z', deviceId: 'phone', ...patch })
const open = (remote?: ReadingPosition) => renderHook(() => useReadingPositions({ activeArea: 'notes', pageId: 'page', hasCurrentPage: true, loadReadingPosition: async () => remote, saveReadingPosition: vi.fn(async () => undefined) }))

test('opening a note uses a newer position from the phone instead of the stale local one', async () => {
  writeLocalReadingPositions(new Map([['page', { fraction: 0.1, scrollTop: 800, updatedAt: '2026-10-19T09:00:00.000Z' }]]))
  const { result } = open(record())
  await waitFor(() => expect(result.current.loadedReadingPosition?.position.fraction).toBe(0.6))
  expect(result.current.loadedReadingPosition?.position.anchor).toBe(90_000)
  expect(result.current.loadedReadingPosition?.position.scrollTop).toBeUndefined()
})

test('a newer local position is kept, as is one this device published itself', async () => {
  writeLocalReadingPositions(new Map([['page', { fraction: 0.1, scrollTop: 800, updatedAt: '2026-10-19T15:00:00.000Z' }]]))
  const newer = open(record())
  await waitFor(() => expect(newer.result.current.loadedReadingPosition).toBeDefined())
  expect(newer.result.current.loadedReadingPosition?.position.scrollTop).toBe(800)
  const own = open(record({ deviceId: legacyDeviceId(), updatedAt: '2026-10-19T23:00:00.000Z' }))
  await waitFor(() => expect(own.result.current.loadedReadingPosition).toBeDefined())
  expect(own.result.current.loadedReadingPosition?.position.fraction).toBe(0.1)
})

test('scrolling publishes the fraction together with the exact anchor', async () => {
  const save = vi.fn(async (_pageId: string, _fraction: number, _anchor?: number) => undefined)
  const { result } = renderHook(() => useReadingPositions({ activeArea: 'notes', pageId: 'page', hasCurrentPage: true, loadReadingPosition: async () => undefined, saveReadingPosition: save }))
  result.current.recordViewportPosition('page', { fraction: 0.3, scrollTop: 100, anchor: 5_000 })
  await result.current.flushDirtyReadingPositions()
  expect(save).toHaveBeenCalledWith('page', 0.3, 5_000)
})
