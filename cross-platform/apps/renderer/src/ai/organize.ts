/**
 * AI organizing and rewriting: prompts and parsers for the model, the plan
 * of changes built from accepted suggestions, and the content matcher behind
 * the side-by-side compare view (where every paragraph went, and whether
 * anything was lost).
 *
 * Pure functions only; the UI and the applier live elsewhere.
 */
import type { NotebookSummary, PageSummary } from '../model'
import { pagePath } from './assistant'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

// ------------------------------------------------------------------ analysis

export interface OrganizeNote { index: number; page: PageSummary; path: string; markdown: string }

export interface CategorySuggestion { name: string; description: string; notes: number[] }
export interface TagSuggestion { note: number; add: string[]; remove: string[] }
export interface MergeSuggestion { title: string; notes: number[]; reason: string }
export interface SplitSuggestion { note: number; reason: string; parts: Array<{ title: string; summary: string }> }
export interface OrganizeSuggestions {
  categories: CategorySuggestion[]
  tags: TagSuggestion[]
  merges: MergeSuggestion[]
  splits: SplitSuggestion[]
}

/** Characters of each note shown to the model during analysis. */
export function analysisExcerptLength(noteCount: number, budget = 90_000) {
  return Math.max(300, Math.min(2_000, Math.floor(budget / Math.max(1, noteCount))))
}

export function analysisMessages(notes: OrganizeNote[], existingTags: string[], request = ''): ChatMessage[] {
  const excerpt = analysisExcerptLength(notes.length)
  const listing = notes.map((note) => [
    `[${note.index}] ${note.page.title || '无标题'}`,
    `位置：${note.path}`,
    note.page.tags.length ? `标签：${note.page.tags.join('、')}` : '',
    `内容：${note.markdown.replace(/\s+/g, ' ').slice(0, excerpt)}${note.markdown.length > excerpt ? '…' : ''}`,
  ].filter(Boolean).join('\n')).join('\n\n')
  return [
    {
      role: 'system',
      content: [
        '你帮用户整理个人笔记。根据内容判断主题，给出可执行的整理建议。',
        '笔记用 [编号] 表示，回答里只用编号指代笔记。只输出一个 JSON 对象，不要输出其他文字。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `${listing}\n\n已有标签：${existingTags.join('、') || '无'}\n${request.trim() ? `\n用户要求：${request.trim()}\n` : ''}
请输出 JSON：
{
  "categories": [{"name": "类别名（简短）", "description": "一句话说明", "notes": [编号, ...]}],
  "tags": [{"note": 编号, "add": ["标签"], "remove": ["标签"]}],
  "merges": [{"title": "合并后的标题", "notes": [编号, 编号], "reason": "为什么适合合并"}],
  "splits": [{"note": 编号, "reason": "为什么适合拆分", "parts": [{"title": "拆出的笔记标题", "summary": "包含哪些内容"}]}]
}
要求：
- categories：把笔记按主题分成 2～8 类；每篇笔记最多归入一类；只有一篇的类别可以不建。
- tags：优先复用已有标签，每篇最多 3 个；只列出需要变化的笔记。
- merges：只合并内容明显重复或属于同一件事的笔记，不确定就不要列。
- splits：只拆分包含多个互不相关主题的长笔记，每篇拆成 2～5 个部分。`,
    },
  ]
}

function jsonObject(content: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content)?.[1]
  const raw = fenced ?? /\{[\s\S]*\}/.exec(content)?.[0]
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

const strings = (value: unknown, max = 20) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim().slice(0, 40)).slice(0, max) : []
const numbers = (value: unknown, valid: Set<number>) => Array.isArray(value) ? [...new Set(value.filter((item): item is number => Number.isInteger(item) && valid.has(item as number)))] : []
const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''

/** Validates the model's JSON against the notes it was shown; drops anything malformed. */
export function parseSuggestions(content: string, noteCount: number): OrganizeSuggestions {
  const value = jsonObject(content)
  const valid = new Set(Array.from({ length: noteCount }, (_, index) => index + 1))
  const list = (key: string) => Array.isArray(value?.[key]) ? value[key] as Array<Record<string, unknown>> : []
  const usedInCategory = new Set<number>()
  const categories = list('categories').flatMap((item) => {
    const name = text(item.name, 40)
    const notes = numbers(item.notes, valid).filter((note) => !usedInCategory.has(note))
    notes.forEach((note) => usedInCategory.add(note))
    return name && notes.length ? [{ name, description: text(item.description, 200), notes }] : []
  })
  const tags = list('tags').flatMap((item) => {
    const note = Number(item.note)
    const add = strings(item.add, 3)
    const remove = strings(item.remove, 10)
    return valid.has(note) && (add.length || remove.length) ? [{ note, add, remove }] : []
  })
  const merges = list('merges').flatMap((item) => {
    const notes = numbers(item.notes, valid)
    const title = text(item.title, 80)
    return notes.length >= 2 && title ? [{ title, notes, reason: text(item.reason, 200) }] : []
  })
  const splits = list('splits').flatMap((item) => {
    const note = Number(item.note)
    const parts = (Array.isArray(item.parts) ? item.parts as Array<Record<string, unknown>> : [])
      .map((part) => ({ title: text(part.title, 80), summary: text(part.summary, 200) }))
      .filter((part) => part.title)
      .slice(0, 6)
    return valid.has(note) && parts.length >= 2 ? [{ note, reason: text(item.reason, 200), parts }] : []
  })
  return { categories, tags, merges, splits }
}

// --------------------------------------------------------- content prompts

const NO_LOSS = '不得遗漏任何信息：事实、数字、步骤、命令、代码、链接、图片引用（notebook-asset:…）和笔记链接（[[page:…]]）都必须保留，代码块原样保留。'

export function mergeMessages(title: string, notes: Array<{ title: string; markdown: string }>, request = ''): ChatMessage[] {
  return [
    { role: 'system', content: `你把用户的几篇笔记合并成一篇。按主题重新组织，去掉重复的部分。${NO_LOSS}只输出合并后的 Markdown 正文，不要输出标题行，也不要解释。` },
    { role: 'user', content: `合并后的标题：${title}\n${request.trim() ? `要求：${request.trim()}\n` : ''}\n${notes.map((note, index) => `===== 笔记 ${index + 1}：${note.title} =====\n${note.markdown}`).join('\n\n')}` },
  ]
}

export function splitMessages(note: { title: string; markdown: string }, parts: Array<{ title: string; summary: string }>): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `你把一篇笔记按主题拆成几篇。每部分的内容原样搬过去，可以调整顺序和标题层级，但不要改写句子。${NO_LOSS}不属于任何部分的内容（例如开头的概述）放进“剩余内容”。`,
    },
    {
      role: 'user',
      content: `建议拆成：\n${parts.map((part) => `- ${part.title}：${part.summary}`).join('\n')}\n\n按下面的格式输出，每部分以单独一行的分隔符开头：\n===== 部分：标题 =====\n（这一部分的 Markdown）\n===== 剩余内容 =====\n（不属于任何部分的 Markdown，没有就留空）\n\n原笔记《${note.title}》：\n${note.markdown}`,
    },
  ]
}

/** Parses "===== 部分：标题 =====" sections from the model's split output. */
export function parseSplit(content: string): { parts: Array<{ title: string; markdown: string }>; remainder: string } {
  const parts: Array<{ title: string; markdown: string }> = []
  let remainder = ''
  let current: { title: string; lines: string[] } | undefined
  let inRemainder = false
  const flush = () => { if (current) parts.push({ title: current.title, markdown: current.lines.join('\n').trim() }); current = undefined }
  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    const part = /^={3,}\s*部分[:：]\s*(.+?)\s*={3,}\s*$/.exec(line)
    if (part) { flush(); inRemainder = false; current = { title: part[1]!.trim(), lines: [] }; continue }
    if (/^={3,}\s*剩余内容\s*={3,}\s*$/.test(line)) { flush(); inRemainder = true; continue }
    if (current) current.lines.push(line)
    else if (inRemainder) remainder += `${line}\n`
  }
  flush()
  return { parts: parts.filter((part) => part.title && part.markdown), remainder: remainder.trim() }
}

export type RewriteMode = 'group' | 'polish' | 'both'
export const REWRITE_MODES: Array<{ id: RewriteMode; label: string; hint: string }> = [
  { id: 'group', label: '整理同类内容', hint: '把散落的同类内容归到一起，理顺顺序和标题层级' },
  { id: 'polish', label: '改写表达', hint: '把过于简略、口语化的句子写成清楚、规范的书面表达' },
  { id: 'both', label: '两者都做', hint: '先归类整理，再改写表达' },
]

export function rewriteMessages(note: { title: string; markdown: string }, mode: RewriteMode, request = ''): ChatMessage[] {
  const task = mode === 'group'
    ? '把同类内容整理到一起：按主题归并散落的段落和列表项，理顺顺序，必要时加小标题。尽量保留原句，不改写措辞。'
    : mode === 'polish'
      ? '保持原有结构，把过于简略、口语化或不通顺的表达改写成清楚、规范的书面语，补全省略的主语和连接词。专有名词、命令、代码不要改。'
      : '先把同类内容整理到一起（按主题归并、理顺顺序、必要时加小标题），再把简略、口语化的表达改写成清楚、规范的书面语。专有名词、命令、代码不要改。'
  return [
    { role: 'system', content: `你帮用户改写一篇笔记。${task}${NO_LOSS}只输出改写后的 Markdown 正文，不要输出标题行，也不要解释。` },
    { role: 'user', content: `${request.trim() ? `补充要求：${request.trim()}\n\n` : ''}笔记《${note.title}》：\n${note.markdown}` },
  ]
}

/** Models sometimes wrap the answer in a fence or repeat the title; undo that. */
export function cleanModelMarkdown(content: string, title?: string): string {
  let value = content.trim()
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(value)
  if (fenced) value = fenced[1]!.trim()
  if (title) {
    const heading = /^#\s+(.+?)\s*\n/.exec(value)
    if (heading && heading[1]!.trim() === title.trim()) value = value.slice(heading[0].length).trim()
  }
  return value
}

// --------------------------------------------------------------------- plan

/** Where a page goes. `parentRef` points at a page created by the same plan. */
export interface PlanLocation { sectionId: string; parentPageId?: string; parentRef?: string; sortOrder: number }

export type PlanOp =
  | { kind: 'create'; ref: string; title: string; markdown: string; location: PlanLocation }
  | { kind: 'update'; pageId: string; expectedUpdatedAt?: string; title?: string; markdown?: string }
  | { kind: 'move'; pageId: string; location: PlanLocation }
  | { kind: 'trash'; pageId: string; expectedUpdatedAt?: string }
  | { kind: 'tags'; pageId: string; tags: string[] }

export interface CompareNote { key: string; title: string; markdown: string; location?: string; tags?: string[] }

export type PlanGroupKind = 'category' | 'tags' | 'merge' | 'split' | 'rewrite'

export interface PlanGroup {
  id: string
  kind: PlanGroupKind
  title: string
  reason?: string
  ops: PlanOp[]
  /** Notes as they are now, and as they will be. */
  before: CompareNote[]
  after: CompareNote[]
}

export const GROUP_KIND_LABEL: Record<PlanGroupKind, string> = { category: '归类', tags: '标签', merge: '合并', split: '拆分', rewrite: '改写' }

/** The parent most of these pages share (where a new folder for them belongs). */
export function commonPlacement(pages: PageSummary[]): { sectionId: string; parentPageId?: string } {
  const counts = new Map<string, { sectionId: string; parentPageId?: string; count: number }>()
  for (const page of pages) {
    const key = `${page.sectionId}|${page.parentPageId ?? ''}`
    const entry = counts.get(key) ?? { sectionId: page.sectionId, parentPageId: page.parentPageId, count: 0 }
    entry.count += 1
    counts.set(key, entry)
  }
  const best = [...counts.values()].sort((a, b) => b.count - a.count)[0]
  return best ? { sectionId: best.sectionId, parentPageId: best.parentPageId } : { sectionId: pages[0]?.sectionId ?? '' }
}

export interface PlanContext {
  pages: PageSummary[]
  notebooks: NotebookSummary[]
  newId(): string
}

/** "工作 / 模块手册" for a place in the tree (a notebook root counts as the notebook). */
export function placementLabel(context: PlanContext, sectionId: string, parentPageId?: string): string {
  const notebook = context.notebooks.find((item) => item.sections.some((section) => section.id === sectionId))?.name ?? ''
  const parent = parentPageId ? context.pages.find((page) => page.id === parentPageId) : undefined
  if (!parent || parent.notebookRoot) return notebook
  return `${pagePath(parent, context.pages, context.notebooks)} / ${parent.title || '无标题'}`
}

/** A category: a folder page where these notes already mostly live, with the notes moved in. */
export function categoryGroup(category: CategorySuggestion, notes: OrganizeNote[], context: PlanContext): PlanGroup | undefined {
  const members = category.notes.map((index) => notes.find((note) => note.index === index)).filter((note): note is OrganizeNote => Boolean(note))
  if (!members.length) return undefined
  const placement = commonPlacement(members.map((note) => note.page))
  const existing = context.pages.find((page) => page.sectionId === placement.sectionId && page.parentPageId === placement.parentPageId && page.title.trim() === category.name.trim() && page.kind !== 'task')
  const ops: PlanOp[] = []
  const ref = existing ? undefined : context.newId()
  if (ref) {
    const siblings = context.pages.filter((page) => page.sectionId === placement.sectionId && page.parentPageId === placement.parentPageId)
    ops.push({ kind: 'create', ref, title: category.name, markdown: category.description, location: { ...placement, sortOrder: Math.max(0, ...siblings.map((page) => page.sortOrder ?? 0)) + 1000 } })
  }
  const target = existing?.id
  const moving = members.filter((note) => note.page.id !== target && note.page.parentPageId !== target)
  moving.forEach((note, index) => ops.push({ kind: 'move', pageId: note.page.id, location: { sectionId: placement.sectionId, ...(target ? { parentPageId: target } : { parentRef: ref }), sortOrder: (index + 1) * 1000 } }))
  if (!moving.length && !ref) return undefined
  const folderLocation = `${placementLabel(context, placement.sectionId, placement.parentPageId)} / ${category.name}`
  return {
    id: context.newId(),
    kind: 'category',
    title: category.name,
    reason: category.description,
    ops,
    before: moving.map((note) => ({ key: note.page.id, title: note.page.title, markdown: note.markdown, location: note.path })),
    after: moving.map((note) => ({ key: note.page.id, title: note.page.title, markdown: note.markdown, location: folderLocation })),
  }
}

export function tagGroup(suggestion: TagSuggestion, notes: OrganizeNote[], context: PlanContext): PlanGroup | undefined {
  const note = notes.find((item) => item.index === suggestion.note)
  if (!note) return undefined
  const removed = new Set(suggestion.remove)
  const next = [...new Set([...note.page.tags.filter((tag) => !removed.has(tag)), ...suggestion.add])]
  if (next.length === note.page.tags.length && next.every((tag) => note.page.tags.includes(tag))) return undefined
  return {
    id: context.newId(),
    kind: 'tags',
    title: note.page.title || '无标题',
    ops: [{ kind: 'tags', pageId: note.page.id, tags: next }],
    before: [{ key: note.page.id, title: note.page.title, markdown: note.markdown, location: note.path, tags: note.page.tags }],
    after: [{ key: note.page.id, title: note.page.title, markdown: note.markdown, location: note.path, tags: next }],
  }
}

/** Merge: one new note where the first source lived; children move under it; sources go to the trash. */
export function mergeGroup(suggestion: MergeSuggestion, notes: OrganizeNote[], mergedMarkdown: string, context: PlanContext): PlanGroup | undefined {
  const sources = suggestion.notes.map((index) => notes.find((note) => note.index === index)).filter((note): note is OrganizeNote => Boolean(note))
  if (sources.length < 2) return undefined
  const first = sources[0]!.page
  const ref = context.newId()
  const sourceIds = new Set(sources.map((note) => note.page.id))
  const ops: PlanOp[] = [{ kind: 'create', ref, title: suggestion.title, markdown: mergedMarkdown, location: { sectionId: first.sectionId, parentPageId: first.parentPageId && !sourceIds.has(first.parentPageId) ? first.parentPageId : undefined, sortOrder: first.sortOrder ?? 0 } }]
  let order = 1000
  for (const source of sources) {
    for (const child of context.pages.filter((page) => page.parentPageId === source.page.id && !sourceIds.has(page.id))) {
      ops.push({ kind: 'move', pageId: child.id, location: { sectionId: first.sectionId, parentRef: ref, sortOrder: order } })
      order += 1000
    }
  }
  for (const source of sources) ops.push({ kind: 'trash', pageId: source.page.id, expectedUpdatedAt: source.page.updatedAt })
  return {
    id: context.newId(),
    kind: 'merge',
    title: suggestion.title,
    reason: suggestion.reason,
    ops,
    before: sources.map((note) => ({ key: note.page.id, title: note.page.title, markdown: note.markdown, location: note.path })),
    after: [{ key: ref, title: suggestion.title, markdown: mergedMarkdown, location: sources[0]!.path }],
  }
}

export const linkPlaceholder = (ref: string) => `{{notebook-ref:${ref}}}`

/** Split: parts become children of the note; the note keeps the remainder and links to them. */
export function splitGroup(suggestion: SplitSuggestion, notes: OrganizeNote[], split: { parts: Array<{ title: string; markdown: string }>; remainder: string }, context: PlanContext): PlanGroup | undefined {
  const note = notes.find((item) => item.index === suggestion.note)
  if (!note || split.parts.length < 2) return undefined
  const refs = split.parts.map(() => context.newId())
  const index = split.parts.map((part, position) => `- [[page:${linkPlaceholder(refs[position]!)}|${part.title.replaceAll(']', '\\]').replaceAll('|', ' ')}]]`).join('\n')
  const remaining = `${split.remainder ? `${split.remainder}\n\n` : ''}## 拆分出的笔记\n\n${index}`
  const ops: PlanOp[] = [
    ...split.parts.map((part, position): PlanOp => ({ kind: 'create', ref: refs[position]!, title: part.title, markdown: part.markdown, location: { sectionId: note.page.sectionId, parentPageId: note.page.id, sortOrder: (position + 1) * 1000 } })),
    { kind: 'update', pageId: note.page.id, expectedUpdatedAt: note.page.updatedAt, markdown: remaining },
  ]
  const childPath = `${note.path} / ${note.page.title || '无标题'}`
  return {
    id: context.newId(),
    kind: 'split',
    title: note.page.title || '无标题',
    reason: suggestion.reason,
    ops,
    before: [{ key: note.page.id, title: note.page.title, markdown: note.markdown, location: note.path }],
    after: [
      { key: note.page.id, title: note.page.title, markdown: remaining, location: note.path },
      ...split.parts.map((part, position) => ({ key: refs[position]!, title: part.title, markdown: part.markdown, location: childPath })),
    ],
  }
}

export function rewriteGroup(note: OrganizeNote, markdown: string, mode: RewriteMode, context: PlanContext): PlanGroup | undefined {
  if (markdown.trim() === note.markdown.trim()) return undefined
  return {
    id: context.newId(),
    kind: 'rewrite',
    title: note.page.title || '无标题',
    reason: REWRITE_MODES.find((item) => item.id === mode)?.label,
    ops: [{ kind: 'update', pageId: note.page.id, expectedUpdatedAt: note.page.updatedAt, markdown }],
    before: [{ key: note.page.id, title: note.page.title, markdown: note.markdown, location: note.path }],
    after: [{ key: note.page.id, title: note.page.title, markdown, location: note.path }],
  }
}

// ----------------------------------------------------------------- compare

export type SourceStatus = 'kept' | 'rewritten' | 'scattered' | 'missing' | 'trivial'
export type ResultStatus = 'kept' | 'rewritten' | 'added' | 'trivial'

export interface Block { key: string; noteKey: string; index: number; markdown: string; text: string }
export interface SourceBlock extends Block { status: SourceStatus; score: number; match?: { noteKey: string; index: number } }
export interface ResultBlock extends Block { status: ResultStatus; score: number; match?: { noteKey: string; index: number } }
export interface CompareResult {
  before: SourceBlock[]
  after: ResultBlock[]
  stats: { kept: number; rewritten: number; scattered: number; missing: number; added: number; total: number }
}

/** Splits Markdown into comparable blocks: paragraphs, headings, single list items, whole code blocks and tables. */
export function splitBlocks(markdown: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let fence: string | undefined
  const flush = () => { if (current.join('').trim()) blocks.push(current.join('\n').trim()); current = [] }
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = /^\s*(```+|~~~+)/.exec(line)?.[1]
    if (fence) {
      current.push(line)
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) { fence = undefined; flush() }
      continue
    }
    if (marker) { flush(); fence = marker; current.push(line); continue }
    if (!line.trim()) { flush(); continue }
    if (/^\s{0,3}#{1,6}\s/.test(line)) { flush(); blocks.push(line.trim()); continue }
    if (/^\s{0,3}([-*+]|\d+[.)])\s/.test(line)) { flush(); current.push(line); continue }
    if (/^\s*\|/.test(line) && current.length && !/^\s*\|/.test(current[current.length - 1]!)) flush()
    current.push(line)
  }
  flush()
  return blocks
}

/** Text without Markdown syntax, lower-cased and without whitespace. */
export function normalizeBlock(markdown: string): string {
  return markdown
    .replace(/^```[^\n]*\n?|```$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[page:[^\]|]+\|([^\]]+)\]\]/g, '$1')
    .replace(/\[\[page:[^\]]+\]\]/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\[[ xX]\]\s/g, '')
    .replace(/[*_`~|>#-]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

function bigrams(value: string): Map<string, number> {
  const result = new Map<string, number>()
  if (value.length === 1) result.set(value, 1)
  for (let index = 0; index < value.length - 1; index += 1) {
    const gram = value.slice(index, index + 2)
    result.set(gram, (result.get(gram) ?? 0) + 1)
  }
  return result
}

/** Dice coefficient over character bigrams (works for Chinese and English alike). */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const left = bigrams(a)
  const right = bigrams(b)
  let overlap = 0
  let total = 0
  for (const [gram, count] of left) { overlap += Math.min(count, right.get(gram) ?? 0); total += count }
  for (const count of right.values()) total += count
  return total ? (2 * overlap) / total : 0
}

/** Share of `part`'s bigrams found in `whole` (how much of a paragraph survives somewhere). */
export function coverage(part: string, whole: Map<string, number>): number {
  const grams = bigrams(part)
  let found = 0
  let total = 0
  for (const [gram, count] of grams) { total += count; found += Math.min(count, whole.get(gram) ?? 0) }
  return total ? found / total : 1
}

const TRIVIAL = 3

/**
 * Where every source paragraph went. A paragraph is kept (found verbatim),
 * rewritten (a similar paragraph exists), scattered (its words survive
 * across several places) or missing. Result paragraphs without a source are
 * marked as added by the AI.
 */
export function compareNotes(before: CompareNote[], after: CompareNote[]): CompareResult {
  const toBlocks = (notes: CompareNote[]) => notes.flatMap((note) => splitBlocks(note.markdown).map((markdown, index) => ({ key: `${note.key}:${index}`, noteKey: note.key, index, markdown, text: normalizeBlock(markdown) })))
  const sources = toBlocks(before)
  const results = toBlocks(after)
  const allResultText = results.map((block) => block.text).join('')
  const resultGrams = bigrams(allResultText)
  const sourceText = sources.map((block) => block.text).join('')
  const sourceGrams = bigrams(sourceText)

  const bestMatch = (block: Block, candidates: Block[]) => {
    let best: { block: Block; score: number } | undefined
    for (const candidate of candidates) {
      if (!candidate.text) continue
      const score = candidate.text.includes(block.text) || (candidate.text.length >= TRIVIAL && block.text.includes(candidate.text) && candidate.text.length / block.text.length > 0.8)
        ? 1
        : similarity(block.text, candidate.text)
      if (!best || score > best.score) best = { block: candidate, score }
      if (score === 1) break
    }
    return best
  }

  const sourceBlocks: SourceBlock[] = sources.map((block) => {
    if (block.text.length <= TRIVIAL) return { ...block, status: 'trivial', score: 1 }
    const best = bestMatch(block, results)
    const match = best ? { noteKey: best.block.noteKey, index: best.block.index } : undefined
    if (best && (best.score === 1 || allResultText.includes(block.text))) return { ...block, status: 'kept', score: 1, match }
    if (best && best.score >= 0.5) return { ...block, status: 'rewritten', score: best.score, match }
    const covered = coverage(block.text, resultGrams)
    if (covered >= 0.75) return { ...block, status: 'scattered', score: covered, match: best && best.score >= 0.25 ? match : undefined }
    return { ...block, status: 'missing', score: Math.max(best?.score ?? 0, covered), match: best && best.score >= 0.25 ? match : undefined }
  })
  const resultBlocks: ResultBlock[] = results.map((block) => {
    if (block.text.length <= TRIVIAL) return { ...block, status: 'trivial', score: 1 }
    const best = bestMatch(block, sources)
    const match = best ? { noteKey: best.block.noteKey, index: best.block.index } : undefined
    if (best && (best.score === 1 || sourceText.includes(block.text))) return { ...block, status: 'kept', score: 1, match }
    if (best && best.score >= 0.5) return { ...block, status: 'rewritten', score: best.score, match }
    if (coverage(block.text, sourceGrams) >= 0.75) return { ...block, status: 'rewritten', score: best?.score ?? 0, match: best && best.score >= 0.25 ? match : undefined }
    return { ...block, status: 'added', score: best?.score ?? 0 }
  })
  const count = (status: SourceStatus) => sourceBlocks.filter((block) => block.status === status).length
  return {
    before: sourceBlocks,
    after: resultBlocks,
    stats: {
      kept: count('kept'),
      rewritten: count('rewritten'),
      scattered: count('scattered'),
      missing: count('missing'),
      added: resultBlocks.filter((block) => block.status === 'added').length,
      total: sourceBlocks.filter((block) => block.status !== 'trivial').length,
    },
  }
}
