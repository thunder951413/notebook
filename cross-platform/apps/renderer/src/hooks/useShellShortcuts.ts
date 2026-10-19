import { useEffect, useRef } from 'react'
import { shellShortcutAction } from '../shell/keys'

export interface ShellShortcutHandlers {
  create: () => void
  toggleSidebar: () => void
  toggleList: () => void
  search: () => void
  settings: () => void
  fullTextSearch: () => void
}

/** Shortcuts per platform are listed in shell/keys.ts. */
export function useShellShortcuts(handlers: ShellShortcutHandlers) {
  // The latest handlers are read at key time; the listener is installed once.
  const latest = useRef(handlers)
  latest.current = handlers
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const inEditor = event.target instanceof Element && Boolean(event.target.closest('.document-editor-content'))
      const action = shellShortcutAction(event, inEditor)
      if (!action) return
      event.preventDefault()
      latest.current[action]()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
