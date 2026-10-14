import { InputRule, mergeAttributes, Node, type JSONContent, type MarkdownToken } from '@tiptap/core'

/**
 * Title links: `[[笔记标题]]` and `[[笔记标题|显示文字]]`.
 *
 * They are plain GFM text, so every client and any Markdown tool keeps them
 * intact; Notebook resolves the title to a page when rendering, indexing and
 * following the link. Identity-based `[[page:<id>…]]` references (blocks,
 * groups, embeds) are a separate syntax and are never matched here.
 *
 * A title may not contain `[`, `]`, `|` or a line break; pages whose titles
 * do are linked by id instead.
 */
export interface WikiLink {
  title: string
  alias?: string
  raw: string
  /** Offset of `raw` in the scanned Markdown. */
  index: number
}

export const MAX_WIKI_TITLE_LENGTH = 200
const TITLE = String.raw`(?!page:)([^\[\]|\n]+?)`
const ALIAS = String.raw`(?:\|([^\[\]\n]+?))?`
const WIKI_LINK_SOURCE = String.raw`\[\[${TITLE}${ALIAS}\]\]`
const WIKI_LINK_AT_START = new RegExp(`^${WIKI_LINK_SOURCE}`)
const WIKI_LINK_GLOBAL = new RegExp(WIKI_LINK_SOURCE, 'g')
/** Typing the closing brackets turns `[[标题]]` into a link. */
export const WIKI_LINK_INPUT_RULE = new RegExp(`${WIKI_LINK_SOURCE}$`)

/** Case, width and whitespace insensitive title comparison key. */
export function normalizeWikiTitle(title: string) {
  return title.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

/** Whether a page title can be written as `[[title]]`. */
export function isLinkableTitle(title: string) {
  const trimmed = title.trim()
  return Boolean(trimmed) && trimmed.length <= MAX_WIKI_TITLE_LENGTH && !/[[\]|\n\r]/.test(trimmed) && !trimmed.startsWith('page:')
}

export function formatWikiLink(title: string, alias?: string) {
  const label = alias?.trim()
  return `[[${title.trim()}${label && label !== title.trim() ? `|${label.replace(/[[\]\n]/g, ' ')}` : ''}]]`
}

function validLink(title: string) {
  const trimmed = title.trim()
  return Boolean(trimmed) && trimmed.length <= MAX_WIKI_TITLE_LENGTH
}

/**
 * Ranges of fenced code blocks and inline code spans. Links inside code are
 * literal text and must neither resolve nor be rewritten on rename.
 */
function codeRanges(markdown: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const fence = /^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1?\2[`~]*[ \t]*$|(?![\s\S]))/gm
  for (const match of markdown.matchAll(fence)) ranges.push([match.index, match.index + match[0].length])
  const inline = /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g
  for (const match of markdown.matchAll(inline)) {
    const start = match.index
    if (!ranges.some(([from, to]) => start >= from && start < to)) ranges.push([start, start + match[0].length])
  }
  return ranges
}

export function extractWikiLinks(markdown: string): WikiLink[] {
  if (!markdown.includes('[[')) return []
  const code = codeRanges(markdown)
  const links: WikiLink[] = []
  for (const match of markdown.matchAll(WIKI_LINK_GLOBAL)) {
    const index = match.index
    if (code.some(([from, to]) => index >= from && index < to)) continue
    if (!validLink(match[1]!)) continue
    const alias = match[2]?.trim()
    links.push({ title: match[1]!.trim(), ...(alias ? { alias } : {}), raw: match[0], index })
  }
  return links
}

/** Text around a link, for backlink lists. */
export function wikiLinkContext(markdown: string, link: Pick<WikiLink, 'index' | 'raw'>, radius = 40) {
  const before = markdown.slice(Math.max(0, link.index - radius), link.index)
  const after = markdown.slice(link.index + link.raw.length, link.index + link.raw.length + radius * 2)
  return `${before}${link.raw}${after}`.replace(/\s+/g, ' ').trim()
}

/**
 * Rewrites links to `oldTitle` (compared with normalizeWikiTitle) so they
 * point at `newTitle`, keeping any display alias. Code is left untouched.
 */
export function renameWikiLinks(markdown: string, oldTitle: string, newTitle: string): { markdown: string; count: number } {
  const key = normalizeWikiTitle(oldTitle)
  if (!key || !isLinkableTitle(newTitle)) return { markdown, count: 0 }
  let count = 0
  let output = ''
  let cursor = 0
  for (const link of extractWikiLinks(markdown)) {
    if (normalizeWikiTitle(link.title) !== key) continue
    output += markdown.slice(cursor, link.index) + formatWikiLink(newTitle, link.alias)
    cursor = link.index + link.raw.length
    count += 1
  }
  return count ? { markdown: output + markdown.slice(cursor), count } : { markdown, count: 0 }
}

/**
 * Title link node shared by Markdown conversion everywhere. The renderer
 * extends it with an interactive node view (open / create the target page).
 */
export const WikiLinkNode = Node.create({
  name: 'wikiLink',
  priority: 1_000,
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      title: { default: '' },
      alias: { default: null },
    }
  },

  parseHTML() {
    return [{
      tag: 'span[data-wiki-link]',
      getAttrs: (element) => ({ title: element.getAttribute('data-title') ?? '', alias: element.getAttribute('data-alias') }),
    }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const title = String(node.attrs.title ?? '')
    const alias = typeof node.attrs.alias === 'string' && node.attrs.alias ? node.attrs.alias : null
    return ['span', mergeAttributes({ 'data-wiki-link': '', 'data-title': title, ...(alias ? { 'data-alias': alias } : {}), class: 'wiki-link' }, { id: HTMLAttributes.id }), alias ?? title]
  },

  renderText({ node }) {
    return formatWikiLink(String(node.attrs.title ?? ''), typeof node.attrs.alias === 'string' ? node.attrs.alias : undefined)
  },

  addInputRules() {
    return [new InputRule({
      find: WIKI_LINK_INPUT_RULE,
      handler: ({ state, range, match }) => {
        const title = match[1]?.trim()
        if (!title || !validLink(title)) return null
        const alias = match[2]?.trim() || null
        state.tr.replaceWith(range.from, range.to, this.type.create({ title, alias }))
      },
    })]
  },

  markdownTokenName: 'wikiLink',
  parseMarkdown(token: MarkdownToken, helpers) {
    return helpers.createNode('wikiLink', { title: token.title, alias: token.alias ?? null })
  },
  renderMarkdown(node: JSONContent) {
    return formatWikiLink(String(node.attrs?.title ?? ''), typeof node.attrs?.alias === 'string' ? node.attrs.alias : undefined)
  },
  markdownTokenizer: {
    name: 'wikiLink',
    level: 'inline',
    start: (source: string) => {
      const index = source.search(/\[\[(?!page:)/)
      return index
    },
    tokenize(source: string) {
      const match = source.match(WIKI_LINK_AT_START)
      if (!match || !validLink(match[1]!)) return undefined
      const alias = match[2]?.trim()
      return { type: 'wikiLink', raw: match[0], title: match[1]!.trim(), ...(alias ? { alias } : {}) }
    },
  },
})
