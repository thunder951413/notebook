import { expect, test, vi } from 'vitest'
import { markdownToDocument } from '../editor/extensions'
import {
  retrieveNotebookLibrary,
  retrievalResultToAIContext,
  splitNotebookDocument,
} from './libraryRetrieval'

const pages = [
  { id: 'fdt', sectionId: 'notes', title: 'FDT 表设置', preview: '设备树调试', updatedLabel: '', tags: [] },
  { id: 'boot', sectionId: 'notes', title: 'U-Boot 启动流程', preview: '启动命令', updatedLabel: '', tags: [] },
  { id: 'private', sectionId: 'private', title: '隐私密钥', preview: 'secret', updatedLabel: '', tags: [], locked: true },
]

test('splits Markdown on top-level blocks while retaining heading paths', () => {
  const document = markdownToDocument([
    '# FDT',
    '',
    '设置设备树地址。',
    '',
    '## 命令',
    '',
    '```bash',
    'fdt addr $dtb_mem_addr',
    'fdt print /',
    '```',
  ].join('\n'))
  const chunks = splitNotebookDocument(pages[0]!, document, 30)
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.some((chunk) => chunk.headingPath.join(' › ') === 'FDT › 命令')).toBe(true)
  expect(chunks.some((chunk) => chunk.markdown.includes('fdt addr $dtb_mem_addr'))).toBe(true)
})

test('does not render empty breadcrumb levels when a document starts at H3', () => {
  const chunks = splitNotebookDocument(
    pages[0]!,
    markdownToDocument('### 命令\n\n`fdt print /`'),
  )
  expect(chunks[0]?.headingPath).toEqual(['命令'])
})

test('retrieves only relevant public document chunks within the transmission budget', async () => {
  const documents: Record<string, Record<string, unknown>> = {
    fdt: markdownToDocument('# FDT 表\n\n先运行 `fdt addr $dtb_mem_addr`，再读取节点。'),
    boot: markdownToDocument('# 启动\n\n使用 run storeboot 启动系统。'),
    private: markdownToDocument('不能发送的 SSH 密钥'),
  }
  const loadDocument = vi.fn(async (pageId: string) => documents[pageId])
  const result = await retrieveNotebookLibrary({
    query: '如何设置 fdt 表',
    candidatePages: pages,
    loadDocument,
    maxCharacters: 200,
  })
  expect(result.chunks[0]).toMatchObject({ pageId: 'fdt' })
  expect(result.chunks.map((chunk) => chunk.markdown).join('\n')).toContain('fdt addr')
  expect(result.chunks.every((chunk) => chunk.pageId !== 'private')).toBe(true)
  expect(loadDocument).not.toHaveBeenCalledWith('private')
  expect(result.totalCharacters).toBeLessThanOrEqual(200)
})

test('converts selected chunks into source-labelled AI context', async () => {
  const result = await retrieveNotebookLibrary({
    query: 'storeboot',
    candidatePages: pages.slice(1, 2),
    loadDocument: async () => markdownToDocument('# 启动\n\nrun storeboot'),
  })
  const context = retrievalResultToAIContext(result)
  expect(context.items[0]).toMatchObject({ relationship: 'retrieved', pageId: 'boot' })
  expect(context.markdown).toContain('检索来源：U-Boot 启动流程')
  expect(context.markdown).toContain('run storeboot')
})

test('stops retrieval before loading documents when the request is cancelled', async () => {
  const controller = new AbortController()
  controller.abort()
  const loadDocument = vi.fn()
  await expect(retrieveNotebookLibrary({
    query: 'fdt',
    candidatePages: pages,
    loadDocument,
    signal: controller.signal,
  })).rejects.toMatchObject({ name: 'AbortError' })
  expect(loadDocument).not.toHaveBeenCalled()
})
