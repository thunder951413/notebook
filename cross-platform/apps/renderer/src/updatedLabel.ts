const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Human label for a page's updatedAt. Same-day edits show a clock time,
 * yesterday and the past week stay relative, older pages fall back to a date.
 */
export function formatUpdatedLabel(updatedAt: string, now = new Date()): string {
  const time = new Date(updatedAt).getTime()
  if (!Number.isFinite(time)) return ''
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (time >= startOfToday) return new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (time >= startOfToday - DAY_MS) return '昨天'
  const days = Math.floor((startOfToday - time) / DAY_MS)
  if (days <= 6) return `${days} 天前`
  return new Date(time).toLocaleDateString('zh-CN')
}
