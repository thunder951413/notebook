import { mergeAttributes, Node, type JSONContent, type MarkdownToken } from '@tiptap/core'
import type { PageLink } from '@notebook/domain'

export type NotebookReferenceTarget =
  | { pageId: string; kind: 'page' }
  | { pageId: string; kind: 'block'; targetId: string }
  | { pageId: string; kind: 'group'; targetId: string }

export type NotebookReference = NotebookReferenceTarget & {
  embed: boolean
  alias?: string
  raw: string
}

const ID_PATTERN = '[A-Za-z0-9][A-Za-z0-9._:-]*'
const ALIAS_PATTERN = String.raw`((?:\\.|[^\]\\\n])+)`
const REFERENCE_SOURCE = `(!)?\\[\\[page:(${ID_PATTERN})(?:#(?:\\^(${ID_PATTERN})|group:(${ID_PATTERN})))?(?:\\|${ALIAS_PATTERN})?\\]\\]`
const REFERENCE_AT_START = new RegExp(`^${REFERENCE_SOURCE}`)
const REFERENCE_GLOBAL = new RegExp(REFERENCE_SOURCE, 'g')
const BLOCK_ANCHOR_AT_START = new RegExp(`^\\s+\\^(${ID_PATTERN})(?=\\s*$)`)
const GROUP_AT_START = new RegExp(
  `^<!--\\s*notebook:group\\s+(${ID_PATTERN}):start(?:\\s+title="([^"\\n]*)")?\\s*-->\\s*\\n([\\s\\S]*?)\\n<!--\\s*notebook:group\\s+\\1:end\\s*-->(?:\\n|$)`,
)

function targetFromMatch(match: RegExpMatchArray): NotebookReferenceTarget {
  const pageId = match[2]!
  if (match[3]) return { pageId, kind: 'block', targetId: match[3] }
  if (match[4]) return { pageId, kind: 'group', targetId: match[4] }
  return { pageId, kind: 'page' }
}

function decodeReferenceAlias(value: string) {
  return value.replace(/\\(.)/g, '$1')
}

export function parseNotebookReference(value: string): NotebookReference | undefined {
  const match = value.match(REFERENCE_AT_START)
  if (!match || match[0] !== value) return undefined
  return {
    ...targetFromMatch(match),
    embed: Boolean(match[1]),
    ...(match[5]?.trim() ? { alias: decodeReferenceAlias(match[5].trim()) } : {}),
    raw: match[0],
  }
}

export function extractNotebookReferences(markdown: string): NotebookReference[] {
  return Array.from(markdown.matchAll(REFERENCE_GLOBAL), (match) => ({
    ...targetFromMatch(match),
    embed: Boolean(match[1]),
    ...(match[5]?.trim() ? { alias: decodeReferenceAlias(match[5].trim()) } : {}),
    raw: match[0],
  }))
}

/**
 * Page links are a disposable local index derived from canonical Markdown.
 * Keeping this builder in sync-contract makes imports, SSH pulls and renderer
 * saves use exactly the same identity and deduplication rules.
 */
export function pageLinksFromNotebookMarkdown(
  pageId: string,
  workspaceId: string,
  markdown: string,
  createdAt: string,
): PageLink[] {
  const unique = new Map<string, PageLink>()
  for (const reference of extractNotebookReferences(markdown)) {
    const kind = reference.embed ? 'embed' : 'link'
    const targetIdentity = reference.kind === 'page' ? 'page' : `${reference.kind}:${reference.targetId}`
    const key = `${reference.pageId}:${kind}:${targetIdentity}`
    if (unique.has(key)) continue
    unique.set(key, {
      id: `markdown-reference:${pageId}:${reference.pageId}:${kind}:${targetIdentity}`,
      workspaceId,
      sourcePageId: pageId,
      targetPageId: reference.pageId,
      kind,
      excerpt: reference.kind === 'page' ? undefined : targetIdentity,
      createdAt,
    })
  }
  return [...unique.values()]
}

export function formatNotebookReference(target: NotebookReferenceTarget, options: { embed?: boolean; alias?: string } = {}) {
  const anchor = target.kind === 'block' ? `#^${target.targetId}` : target.kind === 'group' ? `#group:${target.targetId}` : ''
  const alias = options.alias?.trim()
    ? `|${options.alias.trim().replaceAll('\\', '\\\\').replaceAll(']', '\\]')}`
    : ''
  return `${options.embed ? '!' : ''}[[page:${target.pageId}${anchor}${alias}]]`
}

export function createReferenceId(prefix: 'b' | 'g') {
  return `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
}

type ReferenceTreeNode = {
  type?: string
  attrs?: Record<string, unknown>
  content?: ReferenceTreeNode[]
}

/**
 * Moving a block preserves its anchor because only one copy remains. Copying a
 * block, however, also copies its hidden anchor/group ID. Keep the first
 * occurrence stable for existing links and assign fresh IDs only to duplicates.
 */
export function normalizeReferenceTargetIds(
  document: Record<string, unknown>,
  makeId: (prefix: 'b' | 'g') => string = createReferenceId,
) {
  const clone = structuredClone(document) as ReferenceTreeNode
  const blockIds = new Set<string>()
  const groupIds = new Set<string>()
  const visit = (node: ReferenceTreeNode) => {
    if (node.type === 'blockAnchor') {
      const current = typeof node.attrs?.anchorId === 'string' ? node.attrs.anchorId : ''
      const anchorId = current && !blockIds.has(current) ? current : makeId('b')
      node.attrs = { ...(node.attrs ?? {}), anchorId }
      blockIds.add(anchorId)
    }
    if (node.type === 'blockGroup') {
      const current = typeof node.attrs?.groupId === 'string' ? node.attrs.groupId : ''
      const groupId = current && !groupIds.has(current) ? current : makeId('g')
      node.attrs = { ...(node.attrs ?? {}), groupId }
      groupIds.add(groupId)
    }
    node.content?.forEach(visit)
  }
  visit(clone)
  return clone as Record<string, unknown>
}

export const NotebookLink = Node.create({
  name: 'notebookLink',
  priority: 1_000,
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      pageId: { default: '' },
      targetKind: { default: 'page' },
      targetId: { default: null },
      alias: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-notebook-link]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, {
      'data-notebook-link': '',
      'data-page-id': HTMLAttributes.pageId,
      'data-target-kind': HTMLAttributes.targetKind,
      'data-target-id': HTMLAttributes.targetId,
      class: 'notebook-link',
    }), HTMLAttributes.alias || '关联页面']
  },

  markdownTokenName: 'notebookLink',
  parseMarkdown(token: MarkdownToken, helpers) {
    return helpers.createNode('notebookLink', {
      pageId: token.pageId,
      targetKind: token.targetKind,
      targetId: token.targetId ?? null,
      alias: token.alias ?? null,
    })
  },
  renderMarkdown(node: JSONContent) {
    return formatNotebookReference({
      pageId: String(node.attrs?.pageId ?? ''),
      kind: node.attrs?.targetKind === 'block' || node.attrs?.targetKind === 'group' ? node.attrs.targetKind : 'page',
      ...(node.attrs?.targetKind === 'block' || node.attrs?.targetKind === 'group' ? { targetId: String(node.attrs?.targetId ?? '') } : {}),
    } as NotebookReferenceTarget, { alias: typeof node.attrs?.alias === 'string' ? node.attrs.alias : undefined })
  },
  markdownTokenizer: {
    name: 'notebookLink',
    level: 'inline',
    start: (source: string) => source.indexOf('[[page:'),
    tokenize(source: string) {
      const parsed = source.match(REFERENCE_AT_START)
      if (!parsed || parsed[1]) return undefined
      const target = targetFromMatch(parsed)
      return {
        type: 'notebookLink',
        raw: parsed[0],
        pageId: target.pageId,
        targetKind: target.kind,
        targetId: target.kind === 'page' ? undefined : target.targetId,
        alias: parsed[5]?.trim() ? decodeReferenceAlias(parsed[5].trim()) : undefined,
      }
    },
  },
})

export const NotebookEmbed = Node.create({
  name: 'notebookEmbed',
  // Keep custom block nodes behind paragraphs in the ProseMirror schema.
  // Otherwise insertContent may use an empty embed as the default trailing block.
  priority: 90,
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      pageId: { default: '' },
      targetKind: { default: 'page' },
      targetId: { default: null },
      alias: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-notebook-embed]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, {
      'data-notebook-embed': '',
      'data-page-id': HTMLAttributes.pageId,
      'data-target-kind': HTMLAttributes.targetKind,
      'data-target-id': HTMLAttributes.targetId,
      class: 'notebook-embed',
    }), HTMLAttributes.alias || '嵌入内容']
  },

  markdownTokenName: 'notebookEmbed',
  parseMarkdown(token: MarkdownToken, helpers) {
    return helpers.createNode('notebookEmbed', {
      pageId: token.pageId,
      targetKind: token.targetKind,
      targetId: token.targetId ?? null,
      alias: token.alias ?? null,
    })
  },
  renderMarkdown(node: JSONContent) {
    return formatNotebookReference({
      pageId: String(node.attrs?.pageId ?? ''),
      kind: node.attrs?.targetKind === 'block' || node.attrs?.targetKind === 'group' ? node.attrs.targetKind : 'page',
      ...(node.attrs?.targetKind === 'block' || node.attrs?.targetKind === 'group' ? { targetId: String(node.attrs?.targetId ?? '') } : {}),
    } as NotebookReferenceTarget, { embed: true, alias: typeof node.attrs?.alias === 'string' ? node.attrs.alias : undefined })
  },
  markdownTokenizer: {
    name: 'notebookEmbed',
    level: 'block',
    start: (source: string) => source.indexOf('![[page:'),
    tokenize(source: string) {
      const parsed = source.match(REFERENCE_AT_START)
      if (!parsed?.[1]) return undefined
      const trailing = source.slice(parsed[0].length)
      if (trailing && !/^\s*(?:\n|$)/.test(trailing)) return undefined
      const target = targetFromMatch(parsed)
      const newline = trailing.startsWith('\r\n') ? '\r\n' : trailing.startsWith('\n') ? '\n' : ''
      return {
        type: 'notebookEmbed',
        raw: `${parsed[0]}${newline}`,
        pageId: target.pageId,
        targetKind: target.kind,
        targetId: target.kind === 'page' ? undefined : target.targetId,
        alias: parsed[5]?.trim() ? decodeReferenceAlias(parsed[5].trim()) : undefined,
      }
    },
  },
})

export const BlockAnchor = Node.create({
  name: 'blockAnchor',
  priority: 1_050,
  inline: true,
  group: 'inline',
  atom: true,
  selectable: false,

  addAttributes() {
    return { anchorId: { default: '' } }
  },
  parseHTML() {
    return [{ tag: 'span[data-block-anchor]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', { 'data-block-anchor': HTMLAttributes.anchorId, class: 'block-anchor' }]
  },
  markdownTokenName: 'blockAnchor',
  parseMarkdown(token: MarkdownToken, helpers) {
    return helpers.createNode('blockAnchor', { anchorId: token.anchorId })
  },
  renderMarkdown(node: JSONContent) {
    return ` ^${String(node.attrs?.anchorId ?? '')}`
  },
  markdownTokenizer: {
    name: 'blockAnchor',
    level: 'inline',
    start: (source: string) => {
      const match = source.match(/\s+\^[A-Za-z0-9]/)
      return match?.index ?? -1
    },
    tokenize(source: string) {
      const match = source.match(BLOCK_ANCHOR_AT_START)
      if (!match) return undefined
      return { type: 'blockAnchor', raw: match[0], anchorId: match[1] }
    },
  },
})

export const BlockGroup = Node.create({
  name: 'blockGroup',
  // A group is an explicit range wrapper, never the editor's default block.
  priority: 90,
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      groupId: { default: '' },
      title: { default: null },
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-block-group]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, {
      'data-block-group': HTMLAttributes.groupId,
      'data-group-title': HTMLAttributes.title,
      class: 'block-group',
    }), 0]
  },
  markdownTokenName: 'blockGroup',
  parseMarkdown(token: MarkdownToken, helpers) {
    return helpers.createNode('blockGroup', {
      groupId: token.groupId,
      title: token.title ?? null,
    }, helpers.parseChildren(token.tokens ?? []))
  },
  renderMarkdown(node: JSONContent, helpers) {
    const id = String(node.attrs?.groupId ?? '')
    const title = typeof node.attrs?.title === 'string' && node.attrs.title
      ? ` title="${node.attrs.title.replaceAll('"', '&quot;')}"`
      : ''
    const body = helpers.renderChildren(node.content ?? [], '\n\n').trim()
    return `<!-- notebook:group ${id}:start${title} -->\n\n${body}\n\n<!-- notebook:group ${id}:end -->`
  },
  markdownTokenizer: {
    name: 'blockGroup',
    level: 'block',
    start: (source: string) => source.indexOf('<!-- notebook:group '),
    tokenize(source: string, _tokens: MarkdownToken[], lexer) {
      const match = source.match(GROUP_AT_START)
      if (!match) return undefined
      return {
        type: 'blockGroup',
        raw: match[0],
        groupId: match[1],
        title: match[2]?.replaceAll('&quot;', '"') || undefined,
        tokens: lexer.blockTokens(match[3]!),
      }
    },
  },
})

export const notebookReferenceExtensions = [BlockGroup, NotebookEmbed, BlockAnchor, NotebookLink]
