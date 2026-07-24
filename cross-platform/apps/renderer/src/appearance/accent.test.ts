import { describe, expect, test, vi } from 'vitest'
import { ACCENT_STORAGE_KEY, accentCssVariables, getAccentPreset, isAccentColor, loadAccentColor, saveAccentColor } from './accent'

describe('accent appearance settings', () => {
  test('accepts supported colors and falls back to purple', () => {
    expect(isAccentColor('blue')).toBe(true)
    expect(isAccentColor('black')).toBe(false)
    expect(loadAccentColor({ getItem: () => 'green' })).toBe('green')
    expect(loadAccentColor({ getItem: () => 'invalid' })).toBe('purple')
  })

  test('persists the selected color and exposes matching CSS variables', () => {
    const setItem = vi.fn()
    saveAccentColor('orange', { setItem })
    expect(setItem).toHaveBeenCalledWith(ACCENT_STORAGE_KEY, 'orange')
    const orange = getAccentPreset('orange')
    expect(accentCssVariables('orange')).toMatchObject({
      '--accent': orange.main,
      '--accent-soft': orange.soft,
    })
  })
})
