import { afterEach, describe, expect, test } from 'vitest'
import { loadThemePreference, resolveTheme } from './theme'

afterEach(() => window.localStorage.clear())

describe('theme preference', () => {
  test('falls back to following the system when nothing is stored', () => {
    expect(loadThemePreference()).toBe('system')
  })

  test('loads a persisted preference', () => {
    window.localStorage.setItem('notebook-theme', 'dark')
    expect(loadThemePreference()).toBe('dark')
    window.localStorage.setItem('notebook-theme', 'light')
    expect(loadThemePreference()).toBe('light')
  })

  test('ignores unknown stored values', () => {
    window.localStorage.setItem('notebook-theme', 'sepia')
    expect(loadThemePreference()).toBe('system')
  })

  test('resolves system preference against the current OS appearance', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})
