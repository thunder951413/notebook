/**
 * The AI assistant's notebook-side logic: which notes are in scope, how they
 * are merged into one Markdown document, and the prompts for each task.
 *
 * Everything here is pure (except the explicit loaders) so desktop and tests
 * share the same rules. Android mirrors these rules in Kotlin.
 */
import type { NotebookSummary, PageSummary } from '../model'
import { flattenPageTree } from '../pageTree'

/** A scope is a set of picks; a picked page includes everything below it. */
export interface AssistantScope {
  notebookIds: string[]
  pageIds: string[]
  tagNames: string[]
  /** Explicit extra pages, e.g. from a search. */
  extraPageIds: string[]
}

export const emptyScope = (): AssistantScope => ({ notebookIds: [], pageIds: [], tagNames: [], extraPageIds: [] })

export function scopeIsEmpty(scope: AssistantScope) {
  return !scope.notebookIds.length && !scope.pageIds.length && !scope.tagNames.length && !scope.extraPageIds.length
}

/**
 * Notes in the scope, in tree order (notebook by notebook, parents before
 * children). Tasks are excluded; private notes only when `includeLocked`.
 */
export function resolveScope(scope: AssistantScope, pages: PageSummary[], notebooks: NotebookSummary[], includeLocked = false): PageSummary[] {
  const usable = pages.filter((page) => page.kind !== 'task' && (includeLocked || !page.locked))
  const byId = new Map(usable.map((page) => [page.id, page]))
  const sectionNotebook = new Map(notebooks.flatMap((notebook) => notebook.sections.map((section) => [section.id, notebook.id] as const)))
  const picked = new Set<string>()
  const pickedNotebooks = new Set(scope.notebookIds)
  const pickedTags = new Set(scope.tagNames)
  const roots = new Set(scope.pageIds)
  const extras = new Set(scope.extraPageIds)
  const childrenOf = new Map<string, PageSummary[]>()
  for (const page of usable) if (page.parentPageId) childrenOf.set(page.parentPageId, [...(childrenOf.get(page.parentPageId) ?? []), page])
  const addSubtree = (pageId: string) => {
    if (picked.has(pageId) || !byId.has(pageId)) return
    picked.add(pageId)
    for (const child of childrenOf.get(pageId) ?? []) addSubtree(child.id)
  }
  for (const page of usable) {
    if (pickedNotebooks.has(sectionNotebook.get(page.sectionId) ?? '')) picked.add(page.id)
    if (page.tags.some((tag) => pickedTags.has(tag))) picked.add(page.id)
    if (extras.has(page.id)) picked.add(page.id)
  }
  for (const id of roots) addSubtree(id)
  // Tree order.
  const ordered: PageSummary[] = []
  for (const notebook of notebooks) {
    for (const section of notebook.sections) {
      const sectionPages = usable.filter((candidate) => candidate.sectionId === section.id)
      for (const { page } of flattenPageTree(sectionPages, new Set(sectionPages.map((candidate) => candidate.id)))) if (picked.has(page.id)) ordered.push(page)
    }
  }
  const seen = new Set(ordered.map((page) => page.id))
  for (const page of usable) if (picked.has(page.id) && !seen.has(page.id)) ordered.push(page)
  return ordered
}

/** "工作相关 / 模块手册 / 板子型号" for a page. */
export function pagePath(page: PageSummary, pages: PageSummary[], notebooks: NotebookSummary[]): string {
  const byId = new Map(pages.map((item) => [item.id, item]))
  const parts: string[] = []
  let cursor = page.parentPageId ? byId.get(page.parentPageId) : undefined
  for (let guard = 0; cursor && guard < 32; guard += 1) {
    parts.unshift(cursor.title || '无标题页面')
    cursor = cursor.parentPageId ? byId.get(cursor.parentPageId) : undefined
  }
  const notebook = notebooks.find((item) => item.sections.some((section) => section.id === page.sectionId))
  if (notebook) parts.unshift(notebook.name)
  return parts.join(' / ')
}

export interface MergedNote { page: PageSummary; path: string; markdown: string }

/**
 * Loads every note and merges them into one Markdown document: each note
 * becomes a section headed by its title, with its location underneath and
 * its own headings shifted down one level.
 */
export async function loadMergedNotes(pages: PageSummary[], allPages: PageSummary[], notebooks: NotebookSummary[], loadMarkdown: (pageId: string) => Promise<string | undefined>, signal?: AbortSignal): Promise<MergedNote[]> {
  const notes: MergedNote[] = []
  for (const page of pages) {
    signal?.throwIfAborted()
    const markdown = (await loadMarkdown(page.id)) ?? ''
    notes.push({ page, path: pagePath(page, allPages, notebooks), markdown })
  }
  return notes
}

export function shiftHeadings(markdown: string, by = 1): string {
  let fence: string | undefined
  return markdown.split('\n').map((line) => {
    const marker = /^\s*(```+|~~~+)/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker[0]!
      else if (marker[0] === fence) fence = undefined
      return line
    }
    if (fence) return line
    return line.replace(/^(#{1,6})(\s)/, (_match, hashes: string, space: string) => `${'#'.repeat(Math.min(6, hashes.length + by))}${space}`)
  }).join('\n')
}

export function mergedMarkdown(notes: MergedNote[], title?: string): string {
  const parts = notes.map(({ page, path, markdown }) => {
    const body = shiftHeadings(markdown.trim(), 1)
    return `## ${page.title || '无标题页面'}\n\n> ${path}\n\n${body || '（空白笔记）'}`
  })
  return `${title ? `# ${title}\n\n` : ''}${parts.join('\n\n---\n\n')}\n`
}

export function countCharacters(notes: MergedNote[]) {
  return notes.reduce((total, note) => total + note.markdown.length, 0)
}

export type AssistantTask = 'ask' | 'summary' | 'outline' | 'weekly' | 'todos' | 'custom'

export const ASSISTANT_TASKS: Array<{ id: Exclude<AssistantTask, 'ask' | 'custom'>; label: string; instruction: string }> = [
  { id: 'summary', label: '总结要点', instruction: '把这些笔记的要点整理成一份简明的总结：先用两三句话概括，再分条列出关键信息。' },
  { id: 'outline', label: '整理提纲', instruction: '把这些笔记的内容整理成层次清楚的提纲（多级列表），合并重复内容。' },
  { id: 'weekly', label: '写周报', instruction: '根据这些笔记写一份周报：本周完成、进行中、问题与风险、下周计划。没有依据的部分写“无”。' },
  { id: 'todos', label: '提取待办', instruction: '从这些笔记中找出所有待办事项、未完成的任务和需要跟进的事情，用任务列表（- [ ]）列出，并注明来自哪篇笔记。' },
]

/** Budget for note text sent to the model (the bridge allows 320,000). */
export const ASSISTANT_CONTEXT_CHARACTERS = 120_000

export interface ContextSource { index: number; pageId: string; title: string; path: string }

/**
 * Numbered sources the model cites as [1], [2]… Each note (or excerpt) is a
 * source. Returns the context text and the source table.
 */
export function numberedContext(items: Array<{ pageId: string; title: string; path: string; markdown: string }>, budget = ASSISTANT_CONTEXT_CHARACTERS) {
  const sources: ContextSource[] = []
  const blocks: string[] = []
  let used = 0
  let truncated = false
  for (const item of items) {
    const existing = sources.find((source) => source.pageId === item.pageId)
    const index = existing?.index ?? sources.length + 1
    const remaining = budget - used
    if (remaining <= 200) { truncated = true; break }
    const text = item.markdown.length > remaining ? `${item.markdown.slice(0, remaining)}\n…（已截断）` : item.markdown
    if (item.markdown.length > remaining) truncated = true
    if (!existing) sources.push({ index, pageId: item.pageId, title: item.title, path: item.path })
    blocks.push(`[${index}] ${item.title}（${item.path}）\n${text.trim()}`)
    used += text.length
  }
  return { text: blocks.join('\n\n====\n\n'), sources, truncated }
}

export const ASSISTANT_SYSTEM_PROMPT = [
  '你是用户个人笔记应用里的 AI 助手。',
  '只能依据用户提供的笔记内容回答；笔记里没有的内容要明确说“笔记中没有找到”，不要编造。',
  '笔记按 [编号] 标明。引用事实时在句末用 [编号] 标注来源，例如 [2]；可以同时引用多个，例如 [1][3]。',
  '用中文回答，格式用 Markdown（标题、列表、表格、代码块）。回答简洁、直接。',
].join('\n')

export function assistantMessages(task: AssistantTask, request: string, context: { text: string; truncated: boolean }, history: Array<{ role: 'user' | 'assistant'; content: string }> = []) {
  const instruction = task === 'ask' || task === 'custom'
    ? request
    : `${ASSISTANT_TASKS.find((item) => item.id === task)?.instruction ?? ''}${request.trim() ? `\n补充要求：${request.trim()}` : ''}`
  return [
    { role: 'system' as const, content: ASSISTANT_SYSTEM_PROMPT },
    { role: 'user' as const, content: `以下是我选中的笔记：\n\n${context.text}${context.truncated ? '\n\n（注意：笔记太长，部分内容已截断。）' : ''}` },
    { role: 'assistant' as const, content: '好的，我已阅读这些笔记。' },
    ...history.slice(-6),
    { role: 'user' as const, content: instruction },
  ]
}

/** Prompt for "search by meaning": the model returns matching source numbers. */
export function searchMessages(query: string, candidates: Array<{ index: number; title: string; path: string; excerpt: string }>) {
  return [
    { role: 'system' as const, content: '你帮助用户在自己的笔记里查找内容。根据含义而不是字面匹配判断相关性。只输出 JSON。' },
    {
      role: 'user' as const,
      content: `候选笔记：\n${candidates.map((item) => `[${item.index}] ${item.title}（${item.path}）\n${item.excerpt}`).join('\n\n')}\n\n要找的是：${query}\n\n按相关程度从高到低，输出最多 10 个相关的笔记，格式：{"results":[{"index":编号,"reason":"一句话说明为什么相关"}]}。都不相关就输出 {"results":[]}。`,
    },
  ]
}

export function parseSearchResults(content: string): Array<{ index: number; reason: string }> {
  const json = /\{[\s\S]*\}/.exec(content)?.[0]
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as { results?: Array<{ index?: unknown; reason?: unknown }> }
    return (parsed.results ?? []).flatMap((item) => Number.isInteger(item.index) ? [{ index: item.index as number, reason: typeof item.reason === 'string' ? item.reason : '' }] : [])
  } catch {
    return []
  }
}

/** Source numbers actually cited in an answer, e.g. "[1][3]" → [1, 3]. */
export function citedSources(answer: string): number[] {
  return [...new Set([...answer.matchAll(/\[(\d{1,3})\]/g)].map((match) => Number(match[1])))].sort((a, b) => a - b)
}

export function scopeLabel(scope: AssistantScope, pages: PageSummary[], notebooks: NotebookSummary[]): string {
  const names = [
    ...scope.notebookIds.map((id) => notebooks.find((notebook) => notebook.id === id)?.name).filter(Boolean),
    ...scope.pageIds.map((id) => pages.find((page) => page.id === id)?.title).filter(Boolean),
    ...scope.tagNames.map((name) => `#${name}`),
  ] as string[]
  if (scope.extraPageIds.length) names.push(`${scope.extraPageIds.length} 篇搜索结果`)
  if (!names.length) return '未选择'
  return names.length > 3 ? `${names.slice(0, 3).join('、')} 等 ${names.length} 项` : names.join('、')
}
