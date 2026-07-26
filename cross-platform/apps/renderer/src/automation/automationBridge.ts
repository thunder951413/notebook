import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'
import type { AutomationProposal, AutomationProposalChange, Page, PageDocument } from '@notebook/domain'
import { automationRepository, WORKSPACE_ID } from '../data/useWorkspaceData'
import { documentToMarkdown, markdownToDocument } from '../editor/extensions'
import { recordDiagnosticEvent } from '../diagnostics/diagnostics'

const safeTitle = z.string().trim().min(1).max(500).refine(
  (value) => [...value].every((character) => character.codePointAt(0)! >= 32 && character.codePointAt(0) !== 127),
  '标题不能包含控制字符',
)
const MAX_PROPOSAL_MARKDOWN_CHARACTERS = 8_000_000

const updateOperationSchema = z.object({
  type: z.literal('update-page'),
  pageId: z.string().min(1),
  expectedUpdatedAt: z.string().min(1),
  title: safeTitle.optional(),
  markdown: z.string().max(2_000_000).optional(),
  sectionId: z.string().min(1).optional(),
  parentPageId: z.string().min(1).nullable().optional(),
  sortOrder: z.number().finite().optional(),
}).refine((value) => ['title', 'markdown', 'sectionId', 'parentPageId', 'sortOrder'].some((key) => key in value), '更新操作没有任何变化')

const createOperationSchema = z.object({
  type: z.literal('create-page'),
  title: safeTitle,
  markdown: z.string().max(2_000_000).default(''),
  sectionId: z.string().min(1),
  parentPageId: z.string().min(1).nullable().optional(),
  sortOrder: z.number().finite().optional(),
})

const deleteOperationSchema = z.object({
  type: z.literal('delete-page'),
  pageId: z.string().min(1),
  expectedUpdatedAt: z.string().min(1),
})

const proposalSchema = z.object({
  title: z.string().trim().min(1).max(200),
  explanation: z.string().max(4_000).optional(),
  source: z.string().min(1).max(200).default('external-ai'),
  operations: z.array(z.discriminatedUnion('type', [updateOperationSchema, createOperationSchema, deleteOperationSchema])).min(1).max(200),
})

const agentUpdateOperationSchema = z.object({
  type: z.literal('update-page'),
  pageId: z.string().min(1),
  title: safeTitle.optional(),
  markdown: z.string().max(2_000_000).optional(),
  sectionId: z.string().min(1).optional(),
  parentPageId: z.string().min(1).nullable().optional(),
  sortOrder: z.number().finite().optional(),
}).refine((value) => ['title', 'markdown', 'sectionId', 'parentPageId', 'sortOrder'].some((key) => key in value), '更新操作没有任何变化')
const agentDeleteOperationSchema = z.object({
  type: z.literal('delete-page'),
  pageId: z.string().min(1),
})
const agentProposalSchema = z.object({
  title: z.string().trim().min(1).max(200),
  explanation: z.string().max(4_000).optional(),
  operations: z.array(z.discriminatedUnion('type', [agentUpdateOperationSchema, createOperationSchema, agentDeleteOperationSchema])).min(1).max(200),
})
export type NotebookAgentProposalInput = z.input<typeof agentProposalSchema>
let automationApplyRunning = false

function referencedAssetIds(markdown: string) {
  return new Set([...markdown.matchAll(/\bnotebook-asset:([a-z0-9._:-]+)/gi)].map((match) => match[1]!))
}

export function validateAutomationMarkdown(markdown: string, baseline = '') {
  if (/<\s*(?:script|iframe|object|embed|link|meta|style|form|input|button|svg|math)\b/i.test(markdown)
    || /\bon[a-z]+\s*=/i.test(markdown)
    || /(?:\]\(\s*<?|(?:href|src)\s*=\s*["']?\s*)(?:javascript|vbscript|data):/i.test(markdown)) {
    throw new Error('AI Markdown 包含脚本、事件处理器或危险 URI')
  }
  if (/<\s*img\b/i.test(markdown)) throw new Error('AI Markdown 不能使用 HTML 图片')
  for (const match of markdown.matchAll(/!\[[^\]\n]*\]\(\s*<?([^)\s>]+)/g)) {
    if (!match[1]!.toLowerCase().startsWith('notebook-asset:')) {
      throw new Error('AI Markdown 图片只能引用 notebook-asset 资源')
    }
  }
  const beforeAssets = referencedAssetIds(baseline)
  const afterAssets = referencedAssetIds(markdown)
  if ([...afterAssets].some((id) => !beforeAssets.has(id))) throw new Error('AI 不得新增或编造附件资源 ID')
  if ([...beforeAssets].some((id) => !afterAssets.has(id))) throw new Error('AI 不得删除已有附件资源引用')
}

export function validateProposalOperations(operations: z.infer<typeof proposalSchema>['operations']) {
  const existingPageIds = new Set<string>()
  let markdownCharacters = 0
  for (const operation of operations) {
    if (operation.type !== 'create-page') {
      if (existingPageIds.has(operation.pageId)) throw new Error(`同一提案不能多次操作同一页面：${operation.pageId}`)
      existingPageIds.add(operation.pageId)
    }
    markdownCharacters += operation.type === 'delete-page' ? 0 : operation.markdown?.length ?? 0
  }
  if (markdownCharacters > MAX_PROPOSAL_MARKDOWN_CHARACTERS) throw new Error('AI 提案正文总量超过 8,000,000 字符限制')
}

export function isPublicAutomationPage(page: Page, publicSectionIds: Set<string>) {
  return !page.deletedAt && !page.locked && Boolean(page.sectionId && publicSectionIds.has(page.sectionId))
}

export function externalProposalView(proposal: AutomationProposal, accessiblePageIds: Set<string>) {
  const containsProtectedSnapshot = proposal.changes.some((change) => change.before && !accessiblePageIds.has(change.before.pageId))
  if (!containsProtectedSnapshot) return proposal
  const { changes, ...metadata } = proposal
  return { ...metadata, changeCount: changes.length, redacted: true }
}

export function validateAcceptedStructuralDependencies(
  proposal: AutomationProposal,
  acceptedIds: Set<string>,
  pages: Page[],
) {
  const acceptedChanges = proposal.changes.filter((change) => acceptedIds.has(change.id))
  for (const change of acceptedChanges) {
    const structural = change.type === 'delete-page' || (change.before && change.before.sectionId !== change.after.sectionId)
    if (!structural) continue
    for (const descendantId of descendantPageIds(pages, change.before?.pageId ?? change.after.pageId)) {
      const dependency = proposal.changes.find((item) => item.after.pageId === descendantId)
      const compatible = change.type === 'delete-page'
        ? dependency?.type === 'delete-page'
        : dependency?.type !== 'delete-page' && dependency?.after.sectionId === change.after.sectionId
      if (!dependency || !acceptedIds.has(dependency.id) || !compatible) {
        throw new Error(`“${change.before?.title ?? change.after.title}”的结构变化必须与全部子页面一起接受`)
      }
    }
  }
}

const GUIDE = `# Notebook Next 外部 AI 修改接口

## 工作方式
1. 使用 GET /v1/pages 分页读取页面；需要正文时再 GET /v1/pages/{pageId}。
2. 修改已有页面时必须回传 expectedUpdatedAt。它是乐观并发基线，页面变化后旧提案不能应用。
3. 使用 POST /v1/proposals 提交修改提案。接口不会直接改写笔记。
4. 用户进入 Notebook AI 工作区查看结构与逐行差异，并逐项批准或拒绝。
5. 批准时，每篇被修改的页面都会先保存手动历史版本，再写入 Markdown 正文并进入正常同步队列。

## 内容规则
- Markdown/GFM 是唯一正文格式；可使用标题、粗体、斜体、链接、代码块、表格、任务列表和引用。
- 图片与附件必须保留 notebook-asset: 资源引用。外部 AI 不得编造、改写或删除未知资源 ID。
- 双链使用现有 Notebook 引用语法；不应把引用展开后的显示内容写回正文。
- 不得写入 HTML 脚本、javascript: 链接、data: 资源或外部追踪图片。
- 不得修改锁定/隐私页面；这些页面不会通过接口返回。
- 整理层级时只能使用接口返回的 sectionId/pageId，且不能把页面移动到其自身或后代下面。
- 一次提案最多 200 项操作、每篇 Markdown 最大 2 MB。大批量整理应拆成主题明确的小提案。
- 删除只会作为“移到回收站”的红色提案出现，必须在 Notebook 中二次确认，不能永久删除。

## 提案示例
\`\`\`json
{
  "title": "整理项目笔记",
  "explanation": "统一标题并补充摘要",
  "source": "my-ai-agent",
  "operations": [
    {
      "type": "update-page",
      "pageId": "页面 UUID",
      "expectedUpdatedAt": "GET 页面时返回的 updatedAt",
      "title": "新标题",
      "markdown": "# 新标题\\n\\n整理后的正文"
    },
    {
      "type": "create-page",
      "sectionId": "现有分区 UUID",
      "parentPageId": null,
      "title": "新增页面",
      "markdown": "# 新增页面"
    },
    {
      "type": "delete-page",
      "pageId": "页面 UUID",
      "expectedUpdatedAt": "GET 页面时返回的 updatedAt"
    }
  ]
}
\`\`\`
`

const openApi = {
  openapi: '3.1.0',
  info: { title: 'Notebook Next Local AI Automation API', version: '1.0.0', description: '本机、需 Bearer Token、所有写入先进入用户审阅提案。' },
  servers: [{ url: 'http://127.0.0.1:47831' }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    schemas: {
      UpdatePage: { type: 'object', required: ['type', 'pageId', 'expectedUpdatedAt'], properties: { type: { const: 'update-page' }, pageId: { type: 'string' }, expectedUpdatedAt: { type: 'string', format: 'date-time' }, title: { type: 'string' }, markdown: { type: 'string' }, sectionId: { type: 'string' }, parentPageId: { type: ['string', 'null'] }, sortOrder: { type: 'number' } } },
      CreatePage: { type: 'object', required: ['type', 'sectionId', 'title'], properties: { type: { const: 'create-page' }, sectionId: { type: 'string' }, parentPageId: { type: ['string', 'null'] }, title: { type: 'string' }, markdown: { type: 'string' }, sortOrder: { type: 'number' } } },
      DeletePage: { type: 'object', required: ['type', 'pageId', 'expectedUpdatedAt'], properties: { type: { const: 'delete-page' }, pageId: { type: 'string' }, expectedUpdatedAt: { type: 'string', format: 'date-time' } } },
    },
  },
  paths: {
    '/v1/guide': { get: { summary: '读取 AI 使用规则', responses: { '200': { description: '规则文档' } } } },
    '/v1/openapi.json': { get: { summary: '读取 OpenAPI 规范', responses: { '200': { description: 'OpenAPI' } } } },
    '/v1/pages': { get: { summary: '分页读取全部页面，或按标题和正文搜索', parameters: [{ name: 'query', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } }, { name: 'cursor', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: '页面摘要与 nextCursor' } } } },
    '/v1/pages/{pageId}': { get: { summary: '读取单页 Markdown 与并发版本', parameters: [{ name: 'pageId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: '页面正文' } } } },
    '/v1/proposals': {
      get: { summary: '列出修改提案', responses: { '200': { description: '提案列表' } } },
      post: { summary: '创建等待用户审阅的修改提案', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['title', 'operations'], properties: { title: { type: 'string' }, explanation: { type: 'string' }, source: { type: 'string' }, operations: { type: 'array', maxItems: 200, items: { oneOf: [{ $ref: '#/components/schemas/UpdatePage' }, { $ref: '#/components/schemas/CreatePage' }, { $ref: '#/components/schemas/DeletePage' }] } } } } } } }, responses: { '201': { description: '提案已创建' }, '409': { description: '页面版本已变化' } } },
    },
    '/v1/proposals/{proposalId}': { get: { summary: '读取提案和审阅状态', parameters: [{ name: 'proposalId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: '提案详情' } } } },
  },
}

function markdownOf(document: PageDocument | undefined) {
  return document?.markdown ?? (document ? documentToMarkdown(document.tiptapJson) : '')
}

function plainText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(plainText).join(' ')
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  return [record.text, record.content].map(plainText).filter(Boolean).join(' ')
}

async function publicSections() {
  const notebooks = await automationRepository.listNotebooks(WORKSPACE_ID)
  const publicNotebookIds = new Set(notebooks.filter((item) => !item.locked).map((item) => item.id))
  const sections = (await Promise.all(notebooks.map((item) => automationRepository.listSections(item.id)))).flat()
  return sections.filter((item) => publicNotebookIds.has(item.notebookId) && !item.deletedAt)
}

async function publicWorkspace() {
  const sections = await publicSections()
  const sectionIds = new Set(sections.map((item) => item.id))
  const pages: Page[] = []
  let cursor: string | undefined
  do {
    const batch = await automationRepository.listPages({ workspaceId: WORKSPACE_ID, includeDeleted: true, limit: 500, cursor })
    pages.push(...batch.items)
    cursor = batch.nextCursor
  } while (cursor)
  const pagesInPublicSections = pages.filter((page) => !page.deletedAt && Boolean(page.sectionId && sectionIds.has(page.sectionId)))
  const visiblePages = pagesInPublicSections.filter((page) => isPublicAutomationPage(page, sectionIds))
  return {
    sections,
    sectionIds,
    pages: visiblePages,
    pageIds: new Set(visiblePages.map((page) => page.id)),
    protectedPageIds: new Set(pagesInPublicSections.filter((page) => page.locked).map((page) => page.id)),
    pagesInPublicSections,
  }
}

function assertValidParent(pageId: string | undefined, sectionId: string, parentPageId: string | undefined, pages: Page[]) {
  if (!parentPageId) return
  const parent = pages.find((page) => page.id === parentPageId)
  if (!parent || parent.sectionId !== sectionId) throw new Error(`目标父页面不存在或不在同一分区：${parentPageId}`)
  const byId = new Map(pages.map((page) => [page.id, page]))
  let cursor: Page | undefined = parent
  const seen = new Set<string>()
  while (cursor) {
    if (cursor.id === pageId) throw new Error('不能把页面移动到它自身或后代下面')
    if (seen.has(cursor.id)) throw new Error('现有页面层级包含循环，已拒绝继续修改')
    seen.add(cursor.id)
    cursor = cursor.parentPageId ? byId.get(cursor.parentPageId) : undefined
  }
}

function descendantPageIds(pages: Page[], pageId: string) {
  const children = new Map<string, string[]>()
  for (const page of pages) {
    if (!page.parentPageId) continue
    const values = children.get(page.parentPageId) ?? []
    values.push(page.id)
    children.set(page.parentPageId, values)
  }
  const result: string[] = []
  const queue = [...(children.get(pageId) ?? [])]
  const seen = new Set<string>()
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
    queue.push(...(children.get(id) ?? []))
  }
  return result
}

function proposalTopology(pages: Page[], changes: AutomationProposalChange[]) {
  const result = new Map(pages.map((page) => [page.id, page]))
  for (const change of changes) {
    if (change.type === 'delete-page' || change.after.deletedAt) {
      result.delete(change.after.pageId)
      continue
    }
    const current = result.get(change.after.pageId)
    result.set(change.after.pageId, {
      ...(current ?? {
        id: change.after.pageId,
        workspaceId: WORKSPACE_ID,
        kind: 'document' as const,
        preview: '',
        favorite: false,
        createdAt: change.after.updatedAt,
        syncStatus: 'pending' as const,
      }),
      title: change.after.title,
      sectionId: change.after.sectionId,
      parentPageId: change.after.parentPageId,
      sortOrder: change.after.sortOrder,
      updatedAt: change.after.updatedAt,
    })
  }
  return [...result.values()]
}

async function handleRequest(operation: string, payload: unknown) {
  if (operation === 'guide') return { format: 'markdown', content: GUIDE }
  if (operation === 'openapi') return openApi
  if (operation === 'list-pages') {
    const value = z.object({ query: z.string().default(''), limit: z.number().finite().default(100), cursor: z.string().optional() }).parse(payload)
    const limit = Math.max(1, Math.min(200, Math.round(value.limit)))
    const workspace = await publicWorkspace()
    const offset = Math.max(0, Number.parseInt(value.cursor ?? '0', 10) || 0)
    const candidates = value.query.trim()
      ? (await automationRepository.searchWorkspace(WORKSPACE_ID, value.query, offset + limit + 1)).filter((page) => workspace.pageIds.has(page.id))
      : workspace.pages
    const visible = candidates.slice(offset, offset + limit)
    return {
      items: await Promise.all(visible.map(async (page) => {
        const document = await automationRepository.getPageDocument(page.id)
        return { id: page.id, title: page.title, preview: page.preview, sectionId: page.sectionId, parentPageId: page.parentPageId, updatedAt: page.updatedAt, markdownBytes: new TextEncoder().encode(markdownOf(document)).byteLength }
      })),
      nextCursor: offset + limit < candidates.length ? String(offset + limit) : undefined,
    }
  }
  if (operation === 'get-page') {
    const { pageId } = z.object({ pageId: z.string().min(1) }).parse(payload)
    const [{ pageIds }, page, document] = await Promise.all([publicWorkspace(), automationRepository.getPage(pageId), automationRepository.getPageDocument(pageId)])
    if (!page || !pageIds.has(page.id)) throw Object.assign(new Error('页面不存在或不可由外部 AI 访问'), { code: 'not_found' })
    return { id: page.id, title: page.title, markdown: markdownOf(document), sectionId: page.sectionId, parentPageId: page.parentPageId, sortOrder: page.sortOrder, updatedAt: page.updatedAt }
  }
  if (operation === 'create-proposal') {
    const value = proposalSchema.parse(payload)
    validateProposalOperations(value.operations)
    const { sectionIds, pages, pageIds, pagesInPublicSections, protectedPageIds } = await publicWorkspace()
    const now = new Date().toISOString()
    const changes: AutomationProposalChange[] = []
    for (const item of value.operations) {
      if (item.type === 'update-page') {
        const [page, document] = await Promise.all([automationRepository.getPage(item.pageId), automationRepository.getPageDocument(item.pageId)])
        if (!page || !pageIds.has(page.id)) throw Object.assign(new Error(`页面不可修改：${item.pageId}`), { code: 'not_found' })
        if (page.updatedAt !== item.expectedUpdatedAt) throw Object.assign(new Error(`页面已变化，请重新读取后生成提案：${page.title}`), { code: 'stale' })
        if (item.sectionId && !sectionIds.has(item.sectionId)) throw new Error(`目标分区不存在或属于隐私笔记本：${item.sectionId}`)
        const targetSectionId = item.sectionId ?? page.sectionId
        const targetParentId = item.parentPageId === undefined ? page.parentPageId : item.parentPageId ?? undefined
        const before = { pageId: page.id, title: page.title, markdown: markdownOf(document), sectionId: page.sectionId, parentPageId: page.parentPageId, sortOrder: page.sortOrder, updatedAt: page.updatedAt }
        if (item.markdown !== undefined) validateAutomationMarkdown(item.markdown, before.markdown)
        if ((item.sectionId && item.sectionId !== page.sectionId) || item.parentPageId !== undefined) {
          const protectedDescendants = descendantPageIds(pagesInPublicSections, page.id).filter((id) => protectedPageIds.has(id))
          if (protectedDescendants.length) throw new Error('页面包含锁定子页，AI 不能移动它的层级或分区')
        }
        changes.push({
          id: crypto.randomUUID(),
          type: 'update-page',
          before,
          after: {
            ...before,
            title: item.title?.trim() || before.title,
            markdown: item.markdown ?? before.markdown,
            sectionId: targetSectionId,
            parentPageId: targetParentId,
            sortOrder: item.sortOrder ?? before.sortOrder,
            updatedAt: now,
          },
        })
      } else if (item.type === 'create-page') {
        if (!sectionIds.has(item.sectionId)) throw new Error(`目标分区不存在或属于隐私笔记本：${item.sectionId}`)
        validateAutomationMarkdown(item.markdown)
        changes.push({
          id: crypto.randomUUID(),
          type: 'create-page',
          after: {
            pageId: crypto.randomUUID(),
            title: item.title.trim(),
            markdown: item.markdown,
            sectionId: item.sectionId,
            parentPageId: item.parentPageId ?? undefined,
            sortOrder: item.sortOrder,
            updatedAt: now,
          },
        })
      } else {
        const [page, document] = await Promise.all([automationRepository.getPage(item.pageId), automationRepository.getPageDocument(item.pageId)])
        if (!page || !pageIds.has(page.id)) throw Object.assign(new Error(`页面不可删除：${item.pageId}`), { code: 'not_found' })
        if (page.updatedAt !== item.expectedUpdatedAt) throw Object.assign(new Error(`页面已变化，请重新读取后生成提案：${page.title}`), { code: 'stale' })
        const protectedDescendants = descendantPageIds(pagesInPublicSections, page.id).filter((id) => protectedPageIds.has(id))
        if (protectedDescendants.length) throw new Error('页面包含锁定子页，AI 不能将其移到回收站')
        const before = { pageId: page.id, title: page.title, markdown: markdownOf(document), sectionId: page.sectionId, parentPageId: page.parentPageId, sortOrder: page.sortOrder, updatedAt: page.updatedAt }
        changes.push({
          id: crypto.randomUUID(),
          type: 'delete-page',
          before,
          after: { ...before, deletedAt: now, updatedAt: now },
        })
      }
    }
    // Moving a parent across sections is one tree operation. Expand all
    // implicit descendant moves into explicit proposal changes so users can
    // see the complete impact before approval and the apply step cannot leave
    // children behind in the old section.
    const explicitPageIds = new Set(value.operations.flatMap((item) => item.type === 'create-page' ? [] : [item.pageId]))
    const explicitChangeCount = changes.length
    for (let changeIndex = 0; changeIndex < explicitChangeCount; changeIndex += 1) {
      const change = changes[changeIndex]!
      if (change.type === 'delete-page') {
        for (const descendantId of descendantPageIds(pages, change.before?.pageId ?? change.after.pageId)) {
          if (explicitPageIds.has(descendantId) || changes.some((item) => item.after.pageId === descendantId)) continue
          const descendant = pages.find((page) => page.id === descendantId)
          if (!descendant) continue
          const document = await automationRepository.getPageDocument(descendant.id)
          const before = {
            pageId: descendant.id,
            title: descendant.title,
            markdown: markdownOf(document),
            sectionId: descendant.sectionId,
            parentPageId: descendant.parentPageId,
            sortOrder: descendant.sortOrder,
            updatedAt: descendant.updatedAt,
          }
          changes.push({ id: crypto.randomUUID(), type: 'delete-page', before, after: { ...before, deletedAt: now, updatedAt: now } })
        }
        continue
      }
      if (!change.before || change.before.sectionId === change.after.sectionId) continue
      for (const descendantId of descendantPageIds(pages, change.before.pageId)) {
        if (explicitPageIds.has(descendantId) || changes.some((item) => item.after.pageId === descendantId)) continue
        const descendant = pages.find((page) => page.id === descendantId)
        if (!descendant) continue
        const document = await automationRepository.getPageDocument(descendant.id)
        const before = {
          pageId: descendant.id,
          title: descendant.title,
          markdown: markdownOf(document),
          sectionId: descendant.sectionId,
          parentPageId: descendant.parentPageId,
          sortOrder: descendant.sortOrder,
          updatedAt: descendant.updatedAt,
        }
        changes.push({
          id: crypto.randomUUID(),
          type: 'update-page',
          before,
          after: { ...before, sectionId: change.after.sectionId, updatedAt: now },
        })
      }
    }
    const finalPages = proposalTopology(pages, changes)
    for (const change of changes) {
      if (change.type === 'delete-page') continue
      if (!change.after.sectionId) throw new Error(`页面没有目标分区：${change.after.title}`)
      assertValidParent(change.before?.pageId, change.after.sectionId, change.after.parentPageId, finalPages)
    }
    const proposal: AutomationProposal = { id: crypto.randomUUID(), workspaceId: WORKSPACE_ID, title: value.title, explanation: value.explanation, source: value.source, status: 'pending', changes, createdAt: now }
    await automationRepository.saveAutomationProposal(proposal)
    recordDiagnosticEvent({ level: 'info', category: 'automation', action: 'proposal-create', status: 'success', message: `${changes.length} 项 · ${value.source}` })
    return { id: proposal.id, status: proposal.status, changeCount: changes.length, review: '请在 Notebook AI 工作区或设置 → AI 与自动化中审阅差异' }
  }
  if (operation === 'list-proposals') {
    const proposals = await automationRepository.listAutomationProposals(WORKSPACE_ID)
    return { items: proposals.map(({ changes, ...proposal }) => ({ ...proposal, changeCount: changes.length })) }
  }
  if (operation === 'get-proposal') {
    const { proposalId } = z.object({ proposalId: z.string().min(1) }).parse(payload)
    const proposal = await automationRepository.getAutomationProposal(proposalId)
    if (!proposal) throw Object.assign(new Error('提案不存在'), { code: 'not_found' })
    const { pageIds } = await publicWorkspace()
    return externalProposalView(proposal, pageIds)
  }
  throw new Error(`不支持的自动化操作：${operation}`)
}

export function useAutomationBridge(onApplied: () => Promise<void>) {
  const [proposals, setProposals] = useState<AutomationProposal[]>([])
  const refresh = useCallback(async () => setProposals(await automationRepository.listAutomationProposals(WORKSPACE_ID)), [])

  useEffect(() => {
    void refresh()
    const automation = window.notebookDesktop?.automation
    if (!automation) return
    return automation.onRequest((request) => {
      void handleRequest(request.operation, request.payload).then(
        (result) => {
          automation.respond({ id: request.id, ok: true, result })
          if (request.operation === 'create-proposal') void refresh()
        },
        (error: unknown) => automation.respond({ id: request.id, ok: false, error: { code: (error as { code?: string }).code ?? (error instanceof z.ZodError ? 'validation_error' : 'request_error'), message: error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join('；') : error instanceof Error ? error.message : '自动化请求失败' } }),
      )
    })
  }, [refresh])

  const reject = useCallback(async (proposalId: string) => {
    await automationRepository.updateAutomationProposalStatus(proposalId, 'rejected')
    await refresh()
    recordDiagnosticEvent({ level: 'info', category: 'automation', action: 'proposal-reject', status: 'success' })
  }, [refresh])

  const create = useCallback(async (payload: unknown) => {
    const result = await handleRequest('create-proposal', payload) as { id: string }
    await refresh()
    return result.id
  }, [refresh])

  const createWriteback = useCallback(async (input: { pageId: string; markdown: string; title: string; explanation?: string }) => {
    const page = await handleRequest('get-page', { pageId: input.pageId }) as { id: string; updatedAt: string }
    return create({
      title: input.title,
      explanation: input.explanation,
      source: 'notebook-ai',
      operations: [{ type: 'update-page', pageId: page.id, expectedUpdatedAt: page.updatedAt, markdown: input.markdown }],
    })
  }, [create])

  const createAgentProposal = useCallback(async (input: NotebookAgentProposalInput) => {
    const value = agentProposalSchema.parse(input)
    const operations = await Promise.all(value.operations.map(async (operation) => {
      if (operation.type === 'create-page') return operation
      const page = await handleRequest('get-page', { pageId: operation.pageId }) as { id: string; updatedAt: string }
      return { ...operation, pageId: page.id, expectedUpdatedAt: page.updatedAt }
    }))
    return create({
      title: value.title,
      explanation: value.explanation,
      source: 'notebook-ai-agent',
      operations,
    })
  }, [create])

  const apply = useCallback(async (proposalId: string, acceptedChangeIds?: string[]) => {
    if (automationApplyRunning) throw new Error('已有 AI 修改正在应用，请稍后再试')
    automationApplyRunning = true
    try {
    const proposal = await automationRepository.getAutomationProposal(proposalId)
    if (!proposal || proposal.status !== 'pending') throw new Error('提案不存在或已经审阅')
    const acceptedIds = new Set(acceptedChangeIds ?? proposal.changes.map((change) => change.id))
    const acceptedChanges = proposal.changes.filter((change) => acceptedIds.has(change.id))
    if (!acceptedChanges.length) throw new Error('至少需要接受一项 AI 修改')
    const { sectionIds, pages } = await publicWorkspace()
    validateAcceptedStructuralDependencies(proposal, acceptedIds, pages)
    const finalPages = proposalTopology(pages, acceptedChanges)
    for (const change of acceptedChanges) {
      if (change.type === 'delete-page') {
        if (!change.before) throw new Error(`删除提案缺少原始页面：${change.after.title}`)
      } else {
      if (!change.after.sectionId || !sectionIds.has(change.after.sectionId)) throw new Error(`目标分区已经不存在：${change.after.title}`)
      safeTitle.parse(change.after.title)
      validateAutomationMarkdown(change.after.markdown, change.before?.markdown ?? '')
      assertValidParent(change.before?.pageId, change.after.sectionId, change.after.parentPageId, finalPages)
      }
      if (!change.before) continue
      const current = await automationRepository.getPage(change.before.pageId)
      if (!current || current.updatedAt !== change.before.updatedAt) {
        await automationRepository.updateAutomationProposalStatus(proposal.id, 'stale')
        await refresh()
        throw new Error(`“${change.before.title}”在提案生成后已变化，请让 AI 重新读取并提交`)
      }
    }
    const prepared: Array<{ page: Page; document?: PageDocument; previousPageId?: string; delete?: boolean }> = []
    for (const change of acceptedChanges) {
      const now = new Date().toISOString()
      if (change.type === 'delete-page') {
        const page = await automationRepository.getPage(change.after.pageId)
        if (!page) throw new Error(`页面不存在：${change.after.title}`)
        prepared.push({
          page: { ...page, deletedAt: now, updatedAt: now, syncStatus: 'pending' },
          previousPageId: page.id,
          delete: true,
        })
        continue
      }
      const editor = markdownToDocument(change.after.markdown)
      if (change.before) {
        const page = await automationRepository.getPage(change.before.pageId)
        if (!page) throw new Error(`页面不存在：${change.before.title}`)
        const updated: Page = { ...page, title: change.after.title, preview: plainText(editor).replace(/\s+/g, ' ').trim().slice(0, 240), sectionId: change.after.sectionId, parentPageId: change.after.parentPageId, sortOrder: change.after.sortOrder, treeUpdatedAt: now, updatedAt: now, syncStatus: 'pending' }
        prepared.push({ page: updated, document: { pageId: page.id, schemaVersion: 3, markdown: change.after.markdown, tiptapJson: editor, updatedAt: now }, previousPageId: page.id })
      } else {
        const page: Page = { id: change.after.pageId, workspaceId: WORKSPACE_ID, sectionId: change.after.sectionId, parentPageId: change.after.parentPageId, sortOrder: change.after.sortOrder ?? Date.now(), treeUpdatedAt: now, kind: 'document', title: change.after.title, preview: plainText(editor).replace(/\s+/g, ' ').trim().slice(0, 240), favorite: false, createdAt: now, updatedAt: now, syncStatus: 'pending' }
        prepared.push({ page, document: { pageId: page.id, schemaVersion: 3, markdown: change.after.markdown, tiptapJson: editor, updatedAt: now } })
      }
    }
    await automationRepository.applyAutomationProposal(proposal.id, prepared, acceptedChanges.map((change) => change.id))
    await onApplied()
    await refresh()
    recordDiagnosticEvent({ level: 'info', category: 'automation', action: 'proposal-apply', status: 'success', message: `${acceptedChanges.length}/${proposal.changes.length} 项` })
    } finally {
      automationApplyRunning = false
    }
  }, [onApplied, refresh])

  return {
    proposals,
    refreshAutomationProposals: refresh,
    createAutomationProposal: create,
    createAutomationWriteback: createWriteback,
    createAutomationAgentProposal: createAgentProposal,
    applyAutomationProposal: apply,
    rejectAutomationProposal: reject,
  }
}
