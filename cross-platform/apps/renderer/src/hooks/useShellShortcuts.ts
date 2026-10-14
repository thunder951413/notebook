import { useEffect, useRef } from 'react'

export interface ShellShortcutHandlers {
  create: () => void
  toggleSidebar: () => void
  toggleList: () => void
  search: () => void
  settings: () => void
  fullTextSearch: () => void
}

/** Mac shortcuts: ⌘N new, ⌘F list search (outside the editor), ⌘⇧F full-text search, ⌃⌘S sidebar, ⌃⌘L note list, ⌘, settings. */
export function useShellShortcuts(handlers: ShellShortcutHandlers) {
  // The latest handlers are read at key time; the listener is installed once.
  const latest = useRef(handlers)
  latest.current = handlers
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.altKey) return
      const key = event.key.toLowerCase()
      const inEditor = event.target instanceof Element && Boolean(event.target.closest('.document-editor-content'))
      if (key === 'n' && !event.shiftKey && !event.ctrlKey) { event.preventDefault(); latest.current.create() }
      else if (key === 'f' && event.shiftKey && !event.ctrlKey) { event.preventDefault(); latest.current.fullTextSearch() }
      else if (key === 'f' && !event.shiftKey && !event.ctrlKey && !inEditor) { event.preventDefault(); latest.current.search() }
      else if (key === 's' && event.ctrlKey) { event.preventDefault(); latest.current.toggleSidebar() }
      else if (key === 'l' && event.ctrlKey) { event.preventDefault(); latest.current.toggleList() }
      else if (key === ',') { event.preventDefault(); latest.current.settings() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
