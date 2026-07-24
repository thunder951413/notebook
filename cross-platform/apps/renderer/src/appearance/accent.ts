import { webDarkTheme, webLightTheme, type Theme } from '@fluentui/react-components'
import type { CSSProperties } from 'react'

export type AccentColor = 'purple' | 'blue' | 'cyan' | 'green' | 'orange' | 'red' | 'pink'

export interface AccentPreset {
  id: AccentColor
  label: string
  main: string
  strong: string
  soft: string
  softStrong: string
  border: string
  darkForeground: string
  darkSoft: string
  rgb: string
}

export const DEFAULT_ACCENT_COLOR: AccentColor = 'purple'
export const ACCENT_STORAGE_KEY = 'notebook-accent-color'

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: 'purple', label: '紫色', main: '#7c3aed', strong: '#6d28d9', soft: '#f0e7fa', softStrong: '#e4d5f5', border: '#9b6bd0', darkForeground: '#d8b8ff', darkSoft: '#49335e', rgb: '124, 58, 237' },
  { id: 'blue', label: '蓝色', main: '#2563eb', strong: '#1d4ed8', soft: '#e8f0fe', softStrong: '#d9e6fd', border: '#6d96ee', darkForeground: '#a9c7ff', darkSoft: '#2b416a', rgb: '37, 99, 235' },
  { id: 'cyan', label: '青色', main: '#0891b2', strong: '#0e7490', soft: '#e3f6fa', softStrong: '#cdeef4', border: '#55adbf', darkForeground: '#8eddec', darkSoft: '#254c55', rgb: '8, 145, 178' },
  { id: 'green', label: '绿色', main: '#15803d', strong: '#166534', soft: '#e7f5eb', softStrong: '#d3edda', border: '#5aa875', darkForeground: '#92d9a9', darkSoft: '#294c36', rgb: '21, 128, 61' },
  { id: 'orange', label: '橙色', main: '#c2410c', strong: '#9a3412', soft: '#fff0e7', softStrong: '#fbdcc9', border: '#dc8b64', darkForeground: '#ffb58e', darkSoft: '#5a3829', rgb: '194, 65, 12' },
  { id: 'red', label: '红色', main: '#dc2626', strong: '#b91c1c', soft: '#fdeaea', softStrong: '#f8d6d6', border: '#e27676', darkForeground: '#ffaaaa', darkSoft: '#5b3032', rgb: '220, 38, 38' },
  { id: 'pink', label: '粉色', main: '#db2777', strong: '#be185d', soft: '#fce8f1', softStrong: '#f8d5e5', border: '#e170a3', darkForeground: '#ffacd0', darkSoft: '#5b3045', rgb: '219, 39, 119' },
] as const

export function isAccentColor(value: unknown): value is AccentColor {
  return ACCENT_PRESETS.some((preset) => preset.id === value)
}

export function loadAccentColor(storage: Pick<Storage, 'getItem'> = localStorage): AccentColor {
  const stored = storage.getItem(ACCENT_STORAGE_KEY)
  return isAccentColor(stored) ? stored : DEFAULT_ACCENT_COLOR
}

export function saveAccentColor(color: AccentColor, storage: Pick<Storage, 'setItem'> = localStorage) {
  storage.setItem(ACCENT_STORAGE_KEY, color)
}

export function getAccentPreset(color: AccentColor): AccentPreset {
  return ACCENT_PRESETS.find((preset) => preset.id === color) ?? ACCENT_PRESETS[0]!
}

export function accentCssVariables(color: AccentColor): CSSProperties {
  const preset = getAccentPreset(color)
  return {
    '--accent': preset.main,
    '--accent-strong': preset.strong,
    '--accent-soft': preset.soft,
    '--accent-soft-strong': preset.softStrong,
    '--accent-border': preset.border,
    '--accent-dark-foreground': preset.darkForeground,
    '--accent-dark-soft': preset.darkSoft,
    '--accent-rgb': preset.rgb,
  } as CSSProperties
}

export function notebookFluentTheme(mode: 'light' | 'dark', color: AccentColor): Theme {
  const preset = getAccentPreset(color)
  const base = mode === 'dark' ? webDarkTheme : webLightTheme
  const foreground = mode === 'dark' ? preset.darkForeground : preset.strong
  return {
    ...base,
    colorBrandBackground: preset.main,
    colorBrandBackground2: mode === 'dark' ? preset.darkSoft : preset.soft,
    colorBrandBackgroundHover: preset.strong,
    colorBrandBackgroundPressed: preset.strong,
    colorBrandBackgroundSelected: preset.main,
    colorBrandForeground1: foreground,
    colorBrandForeground2: foreground,
    colorBrandForegroundLink: foreground,
    colorBrandForegroundLinkHover: mode === 'dark' ? '#ffffff' : preset.strong,
    colorBrandStroke1: preset.main,
    colorBrandStroke2: preset.border,
  }
}
