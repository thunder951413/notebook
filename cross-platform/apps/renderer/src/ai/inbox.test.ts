import { describe, expect, test } from 'vitest'
import type { NotebookSummary, PageSummary } from '../model'
import { pagePath } from './assistant'
import { entryBody, entryFromFile, entryFromText, inboxLocations, inboxMessages, locationsForModel, parseInboxChoices, shortcutFromKeyEvent, shortcutLabel } from './inbox'

const page = (id: string, title: string, extra: Partial<PageSummary> = {}): PageSummary => ({ id, sectionId: 's1', title, preview: '', updatedLabel: '', tags: [], kind: 'document', ...extra })
const notebooks = [{ id: 'n1', name: '工作', emoji: '📒', sections: [{ id: 's1', name: '模块手册', color: '', pageCount: 0 }] }] as NotebookSummary[]
const pages = [
  page('root', '模块手册', { notebookRoot: true }),
  page('a', 'uboot', { parentPageId: 'root', sortOrder: 1 }),
  page('a1', '编译', { parentPageId: 'a' }),
  page('t', '买菜', { parentPageId: 'root', kind: 'task' }),
  page('p', '密码', { parentPageId: 'root', locked: true }),
]
const html = (value: string) => value.replace(/<[^>]+>/g, '').trim()
const bytes = (value: string) => new TextEncoder().encode(value)

describe('entries', () => {
  test('text files become the note, other files are attached', () => {
    const md = entryFromFile('uboot 烧录.md', bytes('# uboot 烧录\n\nfastboot flash'), html)
    expect(md).toMatchObject({ kind: 'note', title: 'uboot 烧录', markdown: 'fastboot flash' })
    const pdf = entryFromFile('datasheet RK3588.pdf', bytes('%PDF'), html)
    expect(pdf).toMatchObject({ kind: 'file', title: 'datasheet RK3588', attachment: { mimeType: 'application/pdf' } })
    expect(entryFromFile('shot.PNG', bytes('x'), html).kind).toBe('image')
    expect(entryBody(pdf, 'asset1')).toBe('[datasheet RK3588.pdf](notebook-asset:asset1)')
    expect(entryBody(entryFromFile('a.png', bytes('x'), html), 'img')).toBe('![a.png](notebook-asset:img)')
  })
  test('copied text is titled by its first line; HTML wins over plain text', () => {
    expect(entryFromText('  \n## 会议纪要\n周五评审', undefined, html)).toMatchObject({ title: '会议纪要', source: '剪贴板文字' })
    expect(entryFromText('plain', '<p>rich</p>', html)).toMatchObject({ markdown: 'rich', source: '剪贴板网页内容' })
    expect(entryFromText('   ', undefined, html)).toBeUndefined()
  })
})

describe('locations and the model', () => {
  test('top level, then every usable note, with readable paths', () => {
    const locations = inboxLocations(pages, notebooks)
    expect(locations.map((location) => location.label)).toEqual(['工作（顶层）', '工作 / 模块手册', '工作 / 模块手册 / uboot', '工作 / 模块手册 / uboot / 编译'])
    expect(locations[0]).toMatchObject({ notebookId: 'n1' })
    expect(locations[0]!.parentPageId).toBeUndefined()
    // Folders (notes with children) come first for the model.
    expect(locationsForModel(locations, pages).map((location) => location.key)).toEqual(['notebook:n1', 'page:root', 'page:a', 'page:a1'])
  })
  test('a top-level page is part of the path unless it repeats the notebook name', () => {
    expect(pagePath(pages[2]!, pages, notebooks)).toBe('工作 / 模块手册 / uboot')
    const same = [page('r', '工作', { notebookRoot: true }), page('x', 'x', { parentPageId: 'r' })]
    expect(pagePath(same[1]!, same, notebooks)).toBe('工作')
  })
  test('answers are checked against what the model was shown', () => {
    const locations = inboxLocations(pages, notebooks)
    const entries = [entryFromText('uboot 的烧录步骤', undefined, html)!, entryFromFile('x.pdf', bytes('x'), html), entryFromText('第三项', undefined, html)!]
    const messages = inboxMessages(entries, locations, ['驱动'])
    expect(messages[1]!.content).toContain('[3] 工作 / 模块手册 / uboot')
    expect(messages[1]!.content).toContain('只能根据文件名判断')
    const parsed = parseInboxChoices('```json\n{"items":[{"item":1,"location":3,"title":"uboot 烧录","tags":["#驱动","驱动","a","b"],"reason":"同主题"},{"item":2,"location":99},{"item":3,"location":1,"newFolder":"杂项"},{"item":1,"location":1}]}\n```', entries, locations)
    expect(parsed.get(entries[0]!.id)).toEqual({ title: 'uboot 烧录', locationKey: 'page:a', newFolder: undefined, tags: ['驱动', 'a', 'b'], reason: '同主题' })
    expect(parsed.has(entries[1]!.id)).toBe(false)
    expect(parsed.get(entries[2]!.id)).toMatchObject({ locationKey: 'notebook:n1', newFolder: '杂项', title: '第三项' })
    expect(parseInboxChoices('没有 JSON', entries, locations).size).toBe(0)
  })
})

describe('shortcut', () => {
  test('a combination needs ⌃, ⌥ or ⌘ and a real key', () => {
    const press = (code: string, modifiers: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>>) => shortcutFromKeyEvent({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers })
    expect(press('KeyN', { ctrlKey: true, altKey: true })).toBe('Control+Alt+KeyN')
    expect(press('KeyN', { shiftKey: true })).toBeUndefined()
    expect(press('AltLeft', { altKey: true })).toBeUndefined()
    expect(press('Space', { metaKey: true, shiftKey: true })).toBe('Shift+Super+Space')
    expect(shortcutLabel('Control+Alt+KeyN')).toBe('⌃⌥N')
    expect(shortcutLabel('Shift+Super+Digit1')).toBe('⇧⌘1')
    expect(shortcutLabel('Control+Alt+KeyN', false)).toBe('Ctrl+Alt+N')
    expect(shortcutLabel('Shift+Super+Digit1', false)).toBe('Shift+Win+1')
    expect(shortcutLabel(null)).toBe('未设置')
  })
})
