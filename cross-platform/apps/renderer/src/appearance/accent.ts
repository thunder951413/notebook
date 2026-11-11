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
  { id: 'purple', label: '紫色', main: '#65489d', strong: '#523886', soft: '#f2eef8', softStrong: '#e6def4', border: '#9c86c7', darkForeground: '#d4c2f7', darkSoft: '#3d3056', rgb: '101, 72, 157' },
  { id: 'blue', label: '蓝色', main: '#3461b8', strong: '#284e99', soft: '#edf2fb', softStrong: '#dde7f8', border: '#7b9cd9', darkForeground: '#b3ccff', darkSoft: '#283b5e', rgb: '52, 97, 184' },
  { id: 'cyan', label: '青色', main: '#1d7a8c', strong: '#166271', soft: '#eaf5f7', softStrong: '#d7ecf0', border: '#6baebd', darkForeground: '#9adce8', darkSoft: '#22454d', rgb: '29, 122, 140' },
  { id: 'green', label: '绿色', main: '#2f7650', strong: '#245e3f', soft: '#ebf4ef', softStrong: '#d9ebe1', border: '#6fae8b', darkForeground: '#9fd8b7', darkSoft: '#254434', rgb: '47, 118, 80' },
  { id: 'orange', label: '橙色', main: '#b85328', strong: '#96411d', soft: '#fbf1ec', softStrong: '#f5e0d5', border: '#d48d6f', darkForeground: '#f7b99e', darkSoft: '#523326', rgb: '184, 83, 40' },
  { id: 'red', label: '红色', main: '#b83a3a', strong: '#962d2d', soft: '#fbeded', softStrong: '#f5dada', border: '#d67e7e', darkForeground: '#f7b0b0', darkSoft: '#522b2d', rgb: '184, 58, 58' },
  { id: 'pink', label: '粉色', main: '#ad3e6e', strong: '#8e3059', soft: '#faedf3', softStrong: '#f3dbe6', border: '#d17fa3', darkForeground: '#f5b3d0', darkSoft: '#502c3d', rgb: '173, 62, 110' },
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
