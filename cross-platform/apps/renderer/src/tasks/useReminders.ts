import { useEffect, useRef } from 'react'
import type { PageSummary } from '../model'

export function nextReminderAt(current: string, recurrenceRule?: string) {
  if (!recurrenceRule || recurrenceRule === 'none') return undefined
  const value = new Date(current)
  const now = Date.now()
  do {
    if (recurrenceRule === 'daily') value.setDate(value.getDate() + 1)
    else if (recurrenceRule === 'weekly') value.setDate(value.getDate() + 7)
    else if (recurrenceRule === 'monthly') value.setMonth(value.getMonth() + 1)
    else return undefined
  } while (value.getTime() <= now)
  return value.toISOString()
}

export function useReminders(pages: PageSummary[], updatePage: (pageId: string, patch: { reminderAt?: string }) => Promise<void>) {
  const delivered = useRef(new Set<string>())
  useEffect(() => {
    const check = () => {
      const now = Date.now()
      for (const page of pages) {
        if (!page.reminderAt || page.completedAt || delivered.current.has(`${page.id}:${page.reminderAt}`)) continue
        const reminder = new Date(page.reminderAt).getTime()
        if (!Number.isFinite(reminder) || reminder > now) continue
        delivered.current.add(`${page.id}:${page.reminderAt}`)
        if (window.notebookDesktop) void window.notebookDesktop.notifications.show(page.title, page.preview || '任务提醒')
        else if ('Notification' in window && Notification.permission === 'granted') {
          const notification = new Notification(page.title, { body: page.preview || '任务提醒', tag: `notebook-reminder-${page.id}` })
          void notification
        }
        void updatePage(page.id, { reminderAt: nextReminderAt(page.reminderAt, page.recurrenceRule) })
      }
    }
    check()
    const timer = window.setInterval(check, 20_000)
    return () => window.clearInterval(timer)
  }, [pages, updatePage])
}
