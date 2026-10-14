/** Shell layout breakpoints and small persisted list preferences. */
export type ShellLayout = 'wide' | 'medium' | 'narrow'
/** wide: docked sidebar; medium: sidebar drawer; narrow: list and editor stack like a phone. */
export const layoutForWidth = (width: number): ShellLayout => width < 760 ? 'narrow' : width < 1100 ? 'medium' : 'wide'

export function readPreference<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const value = globalThis.localStorage?.getItem(key) as T | null
    return value && allowed.includes(value) ? value : fallback
  } catch {
    return fallback
  }
}

export function writePreference(key: string, value: string) {
  try { globalThis.localStorage?.setItem(key, value) } catch { /* storage unavailable */ }
}
