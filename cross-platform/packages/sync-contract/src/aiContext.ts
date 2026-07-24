import { extractNotebookReferences, type NotebookReferenceTarget } from './references'

export type AIContextExpansion = 'embeds' | 'all'

export interface AIContextResource {
  id: string
  kind: 'image' | 'audio' | 'file'
  filename: string
  mimeType: string
  description?: string
}

export type AIContextResolvedSource =
  | {
      status: 'ready'
      pageId: string
      title: string
      markdown: string
      updatedAt?: string
      resources?: AIContextResource[]
    }
  | {
      status: 'locked' | 'missing' | 'deleted'
      pageId: string
      title?: string
    }

export type AIContextSourceResolver = (
  target: NotebookReferenceTarget,
) => Promise<AIContextResolvedSource | undefined>

export interface AIContextPolicy {
  /** Expand only explicit embeds by default. Use "all" only after the user asks to include linked notes. */
  expansion?: AIContextExpansion
  /** Root page is depth 0. */
  maxDepth?: number
  /** Budget applies to canonical Markdown content, excluding source-boundary labels. */
  maxCharacters?: number
  /** Resource binaries are never included here; this only exposes safe metadata to a later multimodal adapter. */
  includeResourceMetadata?: boolean
}

export interface AIContextItem {
  key: string
  relationship: 'root' | 'link' | 'embed'
  depth: number
  target: NotebookReferenceTarget
  pageId: string
  title: string
  markdown: string
  updatedAt?: string
  resources?: AIContextResource[]
  truncated: boolean
}

export interface AIContextWarning {
  code: 'cycle' | 'duplicate' | 'depth-limit' | 'budget-limit' | 'locked' | 'missing' | 'deleted' | 'resolver-error'
  target: NotebookReferenceTarget
  message: string
}

export interface AIContextBundle {
  version: 1
  root: NotebookReferenceTarget
  expansion: AIContextExpansion
  items: AIContextItem[]
  /** Deterministic, source-labelled Markdown ready for a text-model adapter. */
  markdown: string
  warnings: AIContextWarning[]
  totalCharacters: number
  truncated: boolean
}

export interface BuildAIContextOptions {
  root: NotebookReferenceTarget
  resolve: AIContextSourceResolver
  policy?: AIContextPolicy
}

const DEFAULT_MAX_DEPTH = 4
const DEFAULT_MAX_CHARACTERS = 80_000

function targetKey(target: NotebookReferenceTarget) {
  return target.kind === 'page'
    ? `page:${target.pageId}`
    : `page:${target.pageId}#${target.kind}:${target.targetId}`
}

function sourceBoundary(item: AIContextItem) {
  const target = item.target.kind === 'page' ? item.pageId : `${item.pageId}#${item.target.kind}:${item.target.targetId}`
  const resources = item.resources?.length
    ? `\n\n资源：\n${item.resources.map((resource) => `- ${resource.kind}: ${resource.filename} (${resource.mimeType})${resource.description ? ` — ${resource.description}` : ''}`).join('\n')}`
    : ''
  return [
    `<!-- notebook-ai-source:start key="${item.key}" relation="${item.relationship}" depth="${item.depth}" -->`,
    `来源：${item.title}（${target}）`,
    '',
    item.markdown,
    resources,
    `<!-- notebook-ai-source:end key="${item.key}" -->`,
  ].filter((line, index, all) => line || (index > 0 && all[index - 1])).join('\n')
}

/**
 * Builds a read-only AI context snapshot. It never writes expanded content back into a note,
 * never includes resource binaries, and never bypasses the access decision made by `resolve`.
 */
export async function buildAIContextBundle({
  root,
  resolve,
  policy = {},
}: BuildAIContextOptions): Promise<AIContextBundle> {
  const expansion = policy.expansion ?? 'embeds'
  const maxDepth = Math.max(0, policy.maxDepth ?? DEFAULT_MAX_DEPTH)
  const maxCharacters = Math.max(0, policy.maxCharacters ?? DEFAULT_MAX_CHARACTERS)
  const items: AIContextItem[] = []
  const warnings: AIContextWarning[] = []
  const seen = new Set<string>()
  let remaining = maxCharacters

  const warn = (code: AIContextWarning['code'], target: NotebookReferenceTarget, message: string) => {
    warnings.push({ code, target, message })
  }

  const visit = async (
    target: NotebookReferenceTarget,
    relationship: AIContextItem['relationship'],
    depth: number,
    path: string[],
  ): Promise<void> => {
    const key = targetKey(target)
    if (path.includes(key)) {
      warn('cycle', target, `已跳过循环引用：${key}`)
      return
    }
    if (seen.has(key)) {
      warn('duplicate', target, `已跳过重复来源：${key}`)
      return
    }
    if (depth > maxDepth) {
      warn('depth-limit', target, `引用深度超过 ${maxDepth} 层`)
      return
    }
    if (remaining <= 0) {
      warn('budget-limit', target, `上下文已达到 ${maxCharacters} 字符预算`)
      return
    }

    let source: AIContextResolvedSource | undefined
    try {
      source = await resolve(target)
    } catch (error) {
      warn('resolver-error', target, error instanceof Error ? error.message : `无法读取来源：${key}`)
      return
    }
    if (!source) {
      warn('missing', target, `找不到引用目标：${key}`)
      return
    }
    if (source.status !== 'ready') {
      const messages = {
        locked: '隐私内容未解锁，未加入 AI 上下文',
        missing: '引用目标尚未下载或不存在',
        deleted: '引用目标已删除',
      } as const
      warn(source.status, target, messages[source.status])
      return
    }

    seen.add(key)
    const canonical = source.markdown.trim()
    const truncated = canonical.length > remaining
    const markdown = truncated ? canonical.slice(0, remaining) : canonical
    remaining -= markdown.length
    items.push({
      key,
      relationship,
      depth,
      target,
      pageId: source.pageId,
      title: source.title,
      markdown,
      ...(source.updatedAt ? { updatedAt: source.updatedAt } : {}),
      ...(policy.includeResourceMetadata && source.resources?.length ? { resources: source.resources } : {}),
      truncated,
    })
    if (truncated) {
      warn('budget-limit', target, `来源“${source.title}”已按 ${maxCharacters} 字符总预算截断`)
      return
    }

    const nextPath = [...path, key]
    for (const reference of extractNotebookReferences(markdown)) {
      if (!reference.embed && expansion !== 'all') continue
      const { embed, alias: _alias, raw: _raw, ...referenceTarget } = reference
      await visit(referenceTarget, embed ? 'embed' : 'link', depth + 1, nextPath)
    }
  }

  await visit(root, 'root', 0, [])
  const totalCharacters = items.reduce((total, item) => total + item.markdown.length, 0)
  return {
    version: 1,
    root,
    expansion,
    items,
    markdown: items.map(sourceBoundary).join('\n\n'),
    warnings,
    totalCharacters,
    truncated: warnings.some((warning) => warning.code === 'budget-limit' || warning.code === 'depth-limit'),
  }
}
