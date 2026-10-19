/**
 * Keyboard conventions per platform. The app's shortcuts were designed on the
 * Mac (⌘ is the main modifier); Windows and Linux use Ctrl instead, and the
 * ⌃⌘ pairs (sidebar, note list) become Ctrl+Shift.
 */

/** `main.tsx` sets data-platform before the first render; unset (tests) means Mac. */
export function isMacPlatform(): boolean {
  const platform = globalThis.document?.documentElement.dataset.platform
  return platform !== 'windows' && platform !== 'linux'
}

type KeyEventLike = { metaKey: boolean; ctrlKey: boolean }

/** The platform's main modifier: ⌘ on the Mac, Ctrl elsewhere. */
export function hasPrimaryKey(event: KeyEventLike, mac = isMacPlatform()): boolean {
  return mac ? event.metaKey : event.ctrlKey
}

export type ShellShortcutAction = 'create' | 'search' | 'fullTextSearch' | 'toggleSidebar' | 'toggleList' | 'settings'

/** Which shell shortcut a key press is, if any. `inEditor`: the focus is in the document. */
export function shellShortcutAction(
  event: KeyEventLike & { key: string; altKey: boolean; shiftKey: boolean },
  inEditor: boolean,
  mac = isMacPlatform(),
): ShellShortcutAction | undefined {
  const key = event.key.toLowerCase()
  if (mac) {
    // ⌘N new, ⌘F list search (outside the editor), ⌘⇧F full-text search, ⌃⌘S sidebar, ⌃⌘L note list, ⌘, settings.
    if (!event.metaKey || event.altKey) return undefined
    if (key === 'n' && !event.shiftKey && !event.ctrlKey) return 'create'
    if (key === 'f' && event.shiftKey && !event.ctrlKey) return 'fullTextSearch'
    if (key === 'f' && !event.shiftKey && !event.ctrlKey && !inEditor) return 'search'
    if (key === 's' && event.ctrlKey) return 'toggleSidebar'
    if (key === 'l' && event.ctrlKey) return 'toggleList'
    if (key === ',') return 'settings'
    return undefined
  }
  // Ctrl+N new, Ctrl+F list search (outside the editor), Ctrl+Shift+F full-text search,
  // Ctrl+Shift+S sidebar, Ctrl+Shift+L note list, Ctrl+, settings.
  if (!event.ctrlKey || event.altKey || event.metaKey) return undefined
  if (key === 'n' && !event.shiftKey) return 'create'
  if (key === 'f' && event.shiftKey) return 'fullTextSearch'
  if (key === 'f' && !inEditor) return 'search'
  if (key === 's' && event.shiftKey) return 'toggleSidebar'
  if (key === 'l' && event.shiftKey) return 'toggleList'
  if (key === ',' && !event.shiftKey) return 'settings'
  return undefined
}

const HINTS = {
  palette: ['⌘P', 'Ctrl+P'],
  newNote: ['⌘N', 'Ctrl+N'],
  search: ['⌘F', 'Ctrl+F'],
  fullText: ['⌘⇧F', 'Ctrl+Shift+F'],
  sidebar: ['⌃⌘S', 'Ctrl+Shift+S'],
  list: ['⌃⌘L', 'Ctrl+Shift+L'],
  settings: ['⌘,', 'Ctrl+,'],
  paste: ['⌘V', 'Ctrl+V'],
} as const

/** The shortcut as the user types it on this platform, for labels and tooltips. */
export function keyHint(name: keyof typeof HINTS, mac = isMacPlatform()): string {
  return HINTS[name][mac ? 0 : 1]
}

/** Wording that names a system component. */
export const fileManagerName = (mac = isMacPlatform()) => (mac ? '访达' : '文件资源管理器')
export const credentialStoreName = (mac = isMacPlatform()) => (mac ? '钥匙串' : '凭据管理器')
