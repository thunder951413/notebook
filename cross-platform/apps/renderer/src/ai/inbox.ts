/**
 * AI 收纳 (inbox): turn dropped files or whatever is on the clipboard into
 * notes, and let the AI suggest where each one belongs, its title and tags.
 *
 * Pure helpers; the dialog and the workspace writes live elsewhere.
 */
import type { NotebookSummary, PageSummary } from '../model'
import { flattenPageTree } from '../pageTree'
import { decodeImportedText, importedTitle, plainTextToMarkdown, stripRepeatedTitle, textImportKind, TEXT_IMPORT_MAX_BYTES } from '../data/textImport'
import { pagePath } from './assistant'
import type { ChatMessage } from './organize'
import { isMacPlatform } from '../shell/keys'

export interface InboxAttachment { name: string; mimeType: string; data: Uint8Array }

export interface InboxEntry {
  id: string
  /** Where it came from, shown to the user: a file name or “剪贴板文字”. */
  source: string
  kind: 'note' | 'image' | 'file'
  title: string
  /** Note body (Markdown); for images and other files, written around the attachment. */
  markdown: string
  attachment?: InboxAttachment
}

/** A place for a new note: below a note, or (with `notebookId`) a new top-level page of a notebook. */
export interface InboxLocation { key: string; sectionId: string; parentPageId?: string; notebookId?: string; label: string }

export interface InboxChoice {
  title: string
  locationKey: string
  /** A new folder the AI suggests, created under `locationKey`. */
  newFolder?: string
  tags: string[]
  reason?: string
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  rtf: 'application/rtf', csv: 'text/csv', json: 'application/json', zip: 'application/zip',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', mp4: 'video/mp4', mov: 'video/quicktime',
}

export function mimeFor(name: string) {
  return MIME[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

const baseName = (name: string) => (name.split(/[\\/]/).pop() ?? name).replace(/\.[a-z0-9]{1,6}$/i, '').trim() || name

let counter = 0
const entryId = () => `inbox-${Date.now().toString(36)}-${(counter += 1)}`

/**
 * A dropped or copied file. Markdown, text and HTML become the note itself;
 * anything else (PDF, Word, images…) is attached to a note named after it.
 */
export function entryFromFile(name: string, data: Uint8Array, htmlToMarkdown: (html: string) => string): InboxEntry {
  const kind = textImportKind(name)
  if (kind && data.byteLength <= TEXT_IMPORT_MAX_BYTES) {
    const source = decodeImportedText(data)
    const title = importedTitle(name, source, kind)
    const markdown = kind === 'html' ? htmlToMarkdown(source) : kind === 'text' ? plainTextToMarkdown(source) : stripRepeatedTitle(source, title)
    return { id: entryId(), source: name, kind: 'note', title, markdown }
  }
  const mimeType = mimeFor(name)
  return { id: entryId(), source: name, kind: mimeType.startsWith('image/') ? 'image' : 'file', title: baseName(name), markdown: '', attachment: { name, mimeType, data } }
}

/** Copied text or a web selection: the first line (or the HTML title) names the note. */
export function entryFromText(text: string, html: string | undefined, htmlToMarkdown: (html: string) => string): InboxEntry | undefined {
  const markdown = (html?.trim() ? htmlToMarkdown(html) : '').trim() || text.trim()
  if (!markdown) return undefined
  const firstLine = (text.trim() || markdown).split('\n').map((line) => line.replace(/^[#>\-*\s]+/, '').trim()).find(Boolean) ?? ''
  const title = firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine || '剪贴板内容'
  return { id: entryId(), source: html?.trim() ? '剪贴板网页内容' : '剪贴板文字', kind: 'note', title, markdown }
}

export function entryFromImage(name: string, mimeType: string, data: Uint8Array): InboxEntry {
  return { id: entryId(), source: '剪贴板图片', kind: 'image', title: '截图', markdown: '', attachment: { name, mimeType, data } }
}

/** The note body as saved: attachments are linked (images shown) below any text. */
export function entryBody(entry: InboxEntry, assetId?: string): string {
  if (!entry.attachment || !assetId) return entry.markdown
  const label = entry.attachment.name.replace(/[[\]]/g, '')
  const reference = entry.kind === 'image' ? `![${label}](notebook-asset:${assetId})` : `[${label}](notebook-asset:${assetId})`
  return entry.markdown.trim() ? `${entry.markdown.trim()}\n\n${reference}` : reference
}

/** Every place a note can go: a notebook's top level and every note (to go below it). */
export function inboxLocations(pages: PageSummary[], notebooks: NotebookSummary[]): InboxLocation[] {
  const usable = pages.filter((page) => page.kind !== 'task' && !page.locked)
  return notebooks.filter((notebook) => !notebook.locked).flatMap((notebook) => {
    const sectionIds = new Set(notebook.sections.map((section) => section.id))
    const notebookPages = usable.filter((page) => sectionIds.has(page.sectionId))
    const first = notebook.sections[0]
    const top: InboxLocation[] = first ? [{ key: `notebook:${notebook.id}`, sectionId: first.id, notebookId: notebook.id, label: `${notebook.name}（顶层）` }] : []
    return [...top, ...flattenPageTree(notebookPages, new Set(notebookPages.map((page) => page.id))).map(({ page }) => ({
      key: `page:${page.id}`,
      sectionId: page.sectionId,
      parentPageId: page.id,
      label: `${pagePath(page, pages, notebooks)} / ${page.title || '无标题'}`,
    }))]
  })
}

/** Locations shown to the model: folders (notes with children) first, then the rest, up to `limit`. */
export function locationsForModel(locations: InboxLocation[], pages: PageSummary[], limit = 400): InboxLocation[] {
  const parents = new Set(pages.map((page) => page.parentPageId).filter(Boolean))
  const isFolder = (location: InboxLocation) => !location.parentPageId || parents.has(location.parentPageId)
  return [...locations.filter(isFolder), ...locations.filter((location) => !isFolder(location))].slice(0, limit)
}

const EXCERPT = 1_500

export function inboxMessages(entries: InboxEntry[], locations: InboxLocation[], tags: string[], request = ''): ChatMessage[] {
  const places = locations.map((location, index) => `[${index + 1}] ${location.label}`).join('\n')
  const items = entries.map((entry, index) => [
    `<${index + 1}> 来源：${entry.source}`,
    `暂定标题：${entry.title}`,
    entry.attachment ? `类型：${entry.kind === 'image' ? '图片' : `文件（${entry.attachment.mimeType}）`}，只能根据文件名判断` : '',
    entry.markdown.trim() ? `内容：${entry.markdown.slice(0, EXCERPT * 4).replace(/\s+/g, ' ').slice(0, EXCERPT)}${entry.markdown.length > EXCERPT ? '…' : ''}` : '',
  ].filter(Boolean).join('\n')).join('\n\n')
  return [
    {
      role: 'system',
      content: '你帮用户把新收到的资料归档到他的笔记库。根据内容判断每一项最适合放在哪里、标题和标签。只输出一个 JSON 对象，不要输出其他文字。',
    },
    {
      role: 'user',
      content: `笔记库里可以放的位置（放在某篇笔记“下面”就是成为它的子笔记）：\n${places}\n\n已有标签：${tags.join('、') || '无'}\n\n要归档的资料：\n${items}\n${request.trim() ? `\n用户要求：${request.trim()}\n` : ''}
请输出 JSON：
{"items": [{"item": 资料编号, "location": 位置编号, "newFolder": "可选：都不合适时在该位置下新建的目录名", "title": "简洁的标题", "tags": ["标签"], "reason": "一句话说明为什么放这里"}]}
要求：
- 每项资料都要给出；location 只能用上面的编号。
- 优先放进已有的、主题最接近的目录；确实没有合适的才用 newFolder，而且名字要短。
- 标题概括内容，不超过 30 个字；文件类资料保留能识别原文件的关键词。
- 标签优先复用已有标签，每项最多 3 个。`,
    },
  ]
}

function jsonObject(content: string): Record<string, unknown> | undefined {
  const raw = /```(?:json)?\s*([\s\S]*?)```/.exec(content)?.[1] ?? /\{[\s\S]*\}/.exec(content)?.[0]
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** The model's answer, checked against what it was shown; unusable items are left out. */
export function parseInboxChoices(content: string, entries: InboxEntry[], locations: InboxLocation[]): Map<string, InboxChoice> {
  const result = new Map<string, InboxChoice>()
  const items = jsonObject(content)?.items
  if (!Array.isArray(items)) return result
  for (const raw of items as Array<Record<string, unknown>>) {
    const entry = entries[Number(raw.item) - 1]
    const location = locations[Number(raw.location) - 1]
    if (!entry || !location || result.has(entry.id)) continue
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 80) : entry.title
    const newFolder = typeof raw.newFolder === 'string' && raw.newFolder.trim() ? raw.newFolder.trim().slice(0, 40) : undefined
    const tags = Array.isArray(raw.tags) ? [...new Set(raw.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim().replace(/^#/, '').slice(0, 30)).filter(Boolean))].slice(0, 3) : []
    result.set(entry.id, { title, locationKey: location.key, newFolder, tags, reason: typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 120) : undefined })
  }
  return result
}

// ------------------------------------------------------------ the shortcut

export const INBOX_SHORTCUT_KEY = 'notebook-inbox-shortcut-v1'
export const DEFAULT_INBOX_SHORTCUT = 'Control+Alt+KeyN'

const MODIFIER_SYMBOL: Record<string, string> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Super: '⌘' }
const MODIFIER_NAME: Record<string, string> = { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Super: 'Win' }
const MODIFIER_ORDER = ['Control', 'Alt', 'Shift', 'Super']

/** "Control+Alt+KeyN" → "⌃⌥N" on the Mac, "Ctrl+Alt+N" elsewhere. */
export function shortcutLabel(accelerator: string | null | undefined, mac = isMacPlatform()): string {
  if (!accelerator) return '未设置'
  const parts = accelerator.split('+')
  const key = parts.pop() ?? ''
  const keyLabel = key.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Space$/, '空格')
  const modifiers = MODIFIER_ORDER.filter((modifier) => parts.includes(modifier))
  return mac ? `${modifiers.map((modifier) => MODIFIER_SYMBOL[modifier]).join('')}${keyLabel}` : [...modifiers.map((modifier) => MODIFIER_NAME[modifier]), keyLabel].join('+')
}

/**
 * A key press → accelerator, or undefined while only modifiers are held or
 * the combination is too easy to hit by accident (needs ⌃, ⌥ or ⌘).
 */
export function shortcutFromKeyEvent(event: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | undefined {
  if (!/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9])|Space)$/.test(event.code)) return undefined
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return undefined
  const modifiers = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super'].filter(Boolean)
  return [...modifiers, event.code].join('+')
}

export function readInboxShortcut(): string | null {
  try {
    const stored = localStorage.getItem(INBOX_SHORTCUT_KEY)
    return stored === null ? DEFAULT_INBOX_SHORTCUT : stored || null
  } catch {
    return DEFAULT_INBOX_SHORTCUT
  }
}

export function saveInboxShortcut(accelerator: string | null) {
  try { localStorage.setItem(INBOX_SHORTCUT_KEY, accelerator ?? '') } catch { /* storage unavailable */ }
}
