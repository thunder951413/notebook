import { describe, expect, test } from 'vitest'
import { hasPrimaryKey, keyHint, shellShortcutAction } from './keys'

const press = (key: string, modifiers: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers })

describe('shell shortcuts', () => {
  test('Mac: ⌘ is the main key, ⌃⌘ toggles the panes', () => {
    expect(shellShortcutAction(press('n', { metaKey: true }), false, true)).toBe('create')
    expect(shellShortcutAction(press('f', { metaKey: true }), false, true)).toBe('search')
    expect(shellShortcutAction(press('f', { metaKey: true }), true, true)).toBeUndefined()
    expect(shellShortcutAction(press('F', { metaKey: true, shiftKey: true }), true, true)).toBe('fullTextSearch')
    expect(shellShortcutAction(press('s', { metaKey: true, ctrlKey: true }), false, true)).toBe('toggleSidebar')
    expect(shellShortcutAction(press('l', { metaKey: true, ctrlKey: true }), false, true)).toBe('toggleList')
    expect(shellShortcutAction(press(',', { metaKey: true }), false, true)).toBe('settings')
    expect(shellShortcutAction(press('n', { ctrlKey: true }), false, true)).toBeUndefined()
  })
  test('Windows and Linux: Ctrl is the main key, Ctrl+Shift toggles the panes', () => {
    expect(shellShortcutAction(press('n', { ctrlKey: true }), false, false)).toBe('create')
    expect(shellShortcutAction(press('f', { ctrlKey: true }), false, false)).toBe('search')
    expect(shellShortcutAction(press('f', { ctrlKey: true }), true, false)).toBeUndefined()
    expect(shellShortcutAction(press('F', { ctrlKey: true, shiftKey: true }), true, false)).toBe('fullTextSearch')
    expect(shellShortcutAction(press('S', { ctrlKey: true, shiftKey: true }), false, false)).toBe('toggleSidebar')
    expect(shellShortcutAction(press('L', { ctrlKey: true, shiftKey: true }), false, false)).toBe('toggleList')
    expect(shellShortcutAction(press(',', { ctrlKey: true }), false, false)).toBe('settings')
    // Ctrl+S alone, Ctrl+Alt (AltGr) and ⌘ are not ours.
    expect(shellShortcutAction(press('s', { ctrlKey: true }), false, false)).toBeUndefined()
    expect(shellShortcutAction(press('n', { ctrlKey: true, altKey: true }), false, false)).toBeUndefined()
    expect(shellShortcutAction(press('n', { metaKey: true }), false, false)).toBeUndefined()
  })
  test('the main key and the hints follow the platform', () => {
    expect(hasPrimaryKey({ metaKey: true, ctrlKey: false }, true)).toBe(true)
    expect(hasPrimaryKey({ metaKey: true, ctrlKey: false }, false)).toBe(false)
    expect(hasPrimaryKey({ metaKey: false, ctrlKey: true }, false)).toBe(true)
    expect(keyHint('fullText', true)).toBe('⌘⇧F')
    expect(keyHint('sidebar', false)).toBe('Ctrl+Shift+S')
  })
})
