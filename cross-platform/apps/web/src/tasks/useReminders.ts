import { useEffect, useRef } from 'react'
import type { PageSummary } from '../model'

export function useReminders(pages: PageSummary[]) {
  const delivered = useRef(new Set<string>())
  useEffect(() => {
    const check = () => {
      const now = Date.now()
      for (const page of pages) {
        if (!page.reminderAt || page.completedAt || delivered.current.has(`${page.id}:${page.reminderAt}`)) continue
        const reminder = new Date(page.reminderAt).getTime()
        if (reminder > now || now - reminder > 60_000) continue
        delivered.current.add(`${page.id}:${page.reminderAt}`)
        if (window.notebookDesktop) void window.notebookDesktop.notifications.show(page.title, page.preview || '任务提醒')
        else if ('Notification' in window && Notification.permission === 'granted') new Notification(page.title, { body: page.preview || '任务提醒', tag: `notebook-reminder-${page.id}` })
      }
    }
    check()
    const timer = window.setInterval(check, 20_000)
    return () => window.clearInterval(timer)
  }, [pages])
}
