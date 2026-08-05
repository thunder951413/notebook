export type ThemePreference = 'light' | 'dark' | 'system'

export const THEME_PREFERENCE_KEY = 'notebook-theme'

/** Loads the persisted theme preference; anything unknown falls back to following the system. */
export function loadThemePreference(): ThemePreference {
  const saved = window.localStorage?.getItem(THEME_PREFERENCE_KEY)
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system'
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
}
