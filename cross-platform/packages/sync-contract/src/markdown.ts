import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import type { JSONContent } from '@tiptap/core'
import type { PageDocument } from '@notebook/domain'

function extensions() {
  return [
    StarterKit,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit,
    Image.configure({ allowBase64: false }),
    Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
  ]
}

// Building a MarkdownManager resolves the complete Tiptap extension graph and
// is substantially more expensive than parsing a note. The manager has no
// per-document mutable state, so one shared instance keeps large backup
// migrations responsive.
const markdownManager = new MarkdownManager({ extensions: extensions() })

export function markdownToTiptap(markdown: string) {
  return markdownManager.parse(markdown) as Record<string, unknown>
}

export function tiptapToMarkdown(document: Record<string, unknown>) {
  return markdownManager.serialize(document as JSONContent)
}

type LegacyMark = { type?: string; attrs?: Record<string, unknown> }
type LegacyNode = { type?: string; attrs?: Record<string, unknown>; marks?: LegacyMark[]; text?: string; content?: LegacyNode[] }

const supportedMarks = new Set(['bold', 'italic', 'strike', 'code', 'link'])

/**
 * Repairs only unambiguous legacy link spellings. These forms were commonly
 * produced when Markdown was pasted into the old rich-text editor as literal
 * text. Ordinary prose and unknown bracket expressions are left untouched.
 */
export function normalizeLegacyMarkdownSyntax(value: string) {
  const repaired = value
    .replace(/\r\n?/g, '\n')
    .replace(/^[ \t]{4}\\?\[([^\]\n]+)\\?\]\("\[(https?:\/\/[^\]\s]+)\]\((https?:\/\/[^)\s]+)\)"\)\s*$/gim, (_match, label: string, firstUrl: string, secondUrl: string) => (
      firstUrl === secondUrl ? `[${label.replace(/\\$/, '')}](${firstUrl})` : _match
    ))
    .replace(/\[([^\]\n]+)\]\s+\((https?:\/\/[^)\s]+)\)/gi, '[$1]($2)')
    .replace(/\[([^\]\n]+)\]\(\[(https?:\/\/[^\]\s]+)\]\((https?:\/\/[^)\s]+)\)\)/gi, (_match, label: string, firstUrl: string, secondUrl: string) => (
      firstUrl === secondUrl ? `[${label}](${firstUrl})` : _match
    ))
    .replace(/\\\[([^\]\n]+)\\\]\(((?:https?:\/\/|notebook-asset:)[^)\n]+|#[^)\n]*)\)/gi, '[$1]($2)')

  const lines = repaired.split('\n')
  const normalized: string[] = []
  let fence: '```' | '~~~' | undefined
  let pendingBlank = false
  for (const line of lines) {
    const marker = line.trimStart().startsWith('```') ? '```' : line.trimStart().startsWith('~~~') ? '~~~' : undefined
    if (marker) {
      if (pendingBlank && normalized.length) normalized.push('')
      pendingBlank = false
      normalized.push(line)
      fence = fence === marker ? undefined : fence ?? marker
      continue
    }
    if (!fence && (!line.trim() || /^&nbsp;$/i.test(line.trim()))) {
      pendingBlank = true
      continue
    }
    if (pendingBlank && normalized.length) normalized.push('')
    pendingBlank = false
    normalized.push(line)
  }
  return normalized.join('\n').trim()
}

function looksLikeIntentionalMarkdown(value: string) {
  const lines = value.split('\n')
  const listLines = lines.filter((line) => /^\s*(?:[-+*]|\d+[.)])\s+\S/.test(line)).length
  const pairedFence = (value.match(/^\s*(?:```|~~~)/gm)?.length ?? 0) >= 2
  const table = lines.some((line, index) => index > 0 && /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line))
  return lines.some((line) => /^\s*#{1,6}\s+\S/.test(line))
    || lines.some((line) => /^\s*-\s+\[[ xX]\]\s+\S/.test(line))
    || pairedFence
    || table
    || listLines >= 2
    || /\[[^\]\n]+\]\((?:https?:\/\/|notebook-asset:)[^)]+\)/i.test(value)
    || /(?:\*\*|__)\S[\s\S]*?(?:\*\*|__)/.test(value)
}

function plainParagraphText(node: LegacyNode) {
  if (node.type !== 'paragraph') return undefined
  const content = node.content ?? []
  if (!content.every((child) => child.type === 'text' && (!child.marks || child.marks.length === 0))) return undefined
  return content.map((child) => child.text ?? '').join('')
}

function hardBreakParagraphs(value: string): LegacyNode[] {
  return value.split(/\n{2,}/).map((paragraph) => {
    const lines = paragraph.split('\n').map((line) => line.replace(/^(\s*)([-+*])(\s+\S)/, '$1\\$2$3'))
    const content = lines.flatMap((line, index): LegacyNode[] => [
      ...(index ? [{ type: 'hardBreak' }] : []),
      ...(line ? [{ type: 'text', text: line }] : []),
    ])
    return { type: 'paragraph', ...(content.length ? { content } : {}) }
  })
}

function cleanNode(node: LegacyNode): LegacyNode {
  const legacyAssetId = typeof node.attrs?.legacyAssetId === 'string' ? node.attrs.legacyAssetId : ''
  const attrs = node.type === 'image' && legacyAssetId && typeof node.attrs?.src !== 'string'
    ? { ...node.attrs, src: `notebook-asset:${legacyAssetId}` }
    : node.attrs
  return {
    ...node,
    ...(attrs ? { attrs } : {}),
    ...(node.marks ? { marks: node.marks.filter((mark) => supportedMarks.has(mark.type ?? '')) } : {}),
    ...(node.content ? { content: node.content.map(cleanNode) } : {}),
  }
}

/**
 * Converts the old rich-text cache to the single canonical Markdown body.
 *
 * The old app sometimes stored a complete Markdown fragment inside one plain
 * paragraph. We parse only fragments with strong Markdown signals. Plain text
 * with embedded line breaks is represented with hard breaks/paragraphs, and a
 * lone dialogue line such as "- hello" remains literal text rather than
 * silently becoming a list.
 */
export function legacyTiptapToCanonicalMarkdown(document: Record<string, unknown>) {
  const root = cleanNode(document as LegacyNode)
  const content = (root.content ?? []).flatMap((node): LegacyNode[] => {
    const plain = plainParagraphText(node)
    if (plain === undefined) return [node]
    const normalized = normalizeLegacyMarkdownSyntax(plain)
    if (looksLikeIntentionalMarkdown(normalized)) {
      const parsed = markdownManager.parse(normalized) as LegacyNode
      return parsed.content?.length ? parsed.content : [node]
    }
    return normalized.includes('\n') ? hardBreakParagraphs(normalized) : [{ ...node, content: normalized ? [{ type: 'text', text: normalized }] : undefined }]
  })
  return markdownManager.serialize({ type: 'doc', content } as JSONContent)
}

export function migrateLegacyPageDocument(document: PageDocument): PageDocument {
  const markdown = document.schemaVersion >= 3 && document.markdown !== undefined
    ? normalizeLegacyMarkdownSyntax(document.markdown)
    : legacyTiptapToCanonicalMarkdown(document.tiptapJson)
  return {
    pageId: document.pageId,
    schemaVersion: 3,
    markdown,
    tiptapJson: { type: 'doc', content: [] },
    updatedAt: document.updatedAt,
  }
}
