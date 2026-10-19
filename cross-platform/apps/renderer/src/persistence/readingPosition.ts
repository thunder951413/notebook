import type { ReadingPosition } from '@notebook/domain'
import type { ViewportPosition } from './localLayout'

/** A synchronized record as a restorable position: no pixel offset, which only means something on the device that wrote it. */
export function syncedViewportPosition(record: ReadingPosition): ViewportPosition {
  return {
    fraction: Math.max(0, Math.min(1, record.viewportOffsetFraction)),
    ...(record.anchorUtf16Offset > 0 ? { anchor: record.anchorUtf16Offset } : {}),
    updatedAt: record.updatedAt,
  }
}

/**
 * Where to reopen a note. The position kept on this device wins unless another
 * device published a newer one (a local record without a timestamp predates
 * the comparison and yields to it).
 */
export function chooseReadingPosition(local: ViewportPosition | undefined, remote: ReadingPosition | undefined, deviceId: string): ViewportPosition | undefined {
  if (!remote) return local
  const synced = syncedViewportPosition(remote)
  if (!local) return synced
  const fromAnotherDevice = remote.deviceId !== deviceId
  const newer = local.updatedAt === undefined || Date.parse(remote.updatedAt) > Date.parse(local.updatedAt)
  return fromAnotherDevice && newer ? synced : local
}
