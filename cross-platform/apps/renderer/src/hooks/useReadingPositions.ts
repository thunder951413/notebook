import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReadingPosition } from '@notebook/domain'
import { registerFlushHandler } from '../data/flushCoordinator'
import { readLocalReadingPositions, writeLocalReadingPositions, type ViewportPosition } from '../persistence/localLayout'

/**
 * Per-note reading position: restored when a note opens (local first, then
 * the synced record), written locally while scrolling and published to the
 * repository on flush.
 */
export function useReadingPositions({ activeArea, pageId: currentPageId, hasCurrentPage, loadReadingPosition, saveReadingPosition }: {
  activeArea: string
  pageId: string
  hasCurrentPage: boolean
  loadReadingPosition: (pageId: string) => Promise<ReadingPosition | undefined>
  saveReadingPosition: (pageId: string, viewportOffsetFraction: number) => Promise<void>
}) {
  const readingPositionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dirtyReadingPositionIds = useRef(new Set<string>())
  const readingPositions = useRef(new Map<string, ViewportPosition>(Object.entries(readLocalReadingPositions())))
  const [loadedReadingPosition, setLoadedReadingPosition] = useState<{ pageId: string; position: ViewportPosition }>()
  useEffect(() => {
    clearTimeout(readingPositionTimer.current)
    if (activeArea !== 'notes' || !hasCurrentPage) {
      setLoadedReadingPosition(undefined)
      return
    }
    const pageId = currentPageId
    const savedPositions = readingPositions.current
    let cancelled = false
    const local = savedPositions.get(pageId)
    setLoadedReadingPosition(local ? { pageId, position: local } : undefined)
    if (!local) void loadReadingPosition(pageId).then((position) => {
      if (cancelled || !position) return
      const restored = { fraction: position.viewportOffsetFraction }
      savedPositions.delete(pageId)
      savedPositions.set(pageId, restored)
      setLoadedReadingPosition({ pageId, position: restored })
    })
    return () => {
      cancelled = true
      clearTimeout(readingPositionTimer.current)
      const position = savedPositions.get(pageId)
      if (!position) return
      writeLocalReadingPositions(savedPositions)
    }
  }, [activeArea, currentPageId, hasCurrentPage, loadReadingPosition])

  const flushDirtyReadingPositions = useCallback(async () => {
    clearTimeout(readingPositionTimer.current)
    writeLocalReadingPositions(readingPositions.current)
    const dirtyIds = [...dirtyReadingPositionIds.current]
    if (!dirtyIds.length) return
    dirtyReadingPositionIds.current.clear()
    try {
      await Promise.all(dirtyIds.map(async (pageId) => {
        const position = readingPositions.current.get(pageId)
        if (position) await saveReadingPosition(pageId, position.fraction)
      }))
    } catch (error) {
      for (const pageId of dirtyIds) dirtyReadingPositionIds.current.add(pageId)
      throw error
    }
  }, [saveReadingPosition])

  useEffect(() => registerFlushHandler(flushDirtyReadingPositions), [flushDirtyReadingPositions])

  const recordViewportPosition = useCallback((viewedPageId: string, position: ViewportPosition) => {
    readingPositions.current.delete(viewedPageId)
    readingPositions.current.set(viewedPageId, position)
    dirtyReadingPositionIds.current.add(viewedPageId)
    clearTimeout(readingPositionTimer.current)
    readingPositionTimer.current = setTimeout(() => {
      writeLocalReadingPositions(readingPositions.current)
    }, 350)
  }, [])

  return { loadedReadingPosition, flushDirtyReadingPositions, recordViewportPosition }
}
