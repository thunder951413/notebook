import type { Asset } from '@notebook/domain'
import {
  buildAIContextBundle,
  type AIContextBundle,
  type AIContextPolicy,
  type NotebookReferenceTarget,
} from '@notebook/sync-contract'
import type { PageSummary } from '../model'
import { documentToMarkdown } from '../editor/extensions'
import { findReferencedFragment } from '../editor/referenceContent'

export type NotebookAIContextScope = 'current' | 'embeds' | 'all'

export interface NotebookAIContextOptions {
  rootPageId: string
  scope: NotebookAIContextScope
  pages: PageSummary[]
  trashPages: PageSummary[]
  privacyUnlocked: boolean
  loadDocument(pageId: string): Promise<Record<string, unknown> | undefined>
  loadAssets(pageId: string): Promise<Asset[]>
}

function policyForScope(scope: NotebookAIContextScope): AIContextPolicy {
  return {
    expansion: scope === 'all' ? 'all' : 'embeds',
    maxDepth: scope === 'current' ? 0 : 4,
    maxCharacters: 80_000,
    includeResourceMetadata: true,
  }
}

function resourceKind(asset: Asset): 'image' | 'audio' | 'file' {
  return asset.kind === 'image' || asset.kind === 'audio' ? asset.kind : 'file'
}

export async function buildNotebookAIContext(options: NotebookAIContextOptions): Promise<AIContextBundle> {
  const active = new Map(options.pages.map((page) => [page.id, page]))
  const deleted = new Map(options.trashPages.map((page) => [page.id, page]))
  return buildAIContextBundle({
    root: { kind: 'page', pageId: options.rootPageId },
    policy: policyForScope(options.scope),
    resolve: async (target: NotebookReferenceTarget) => {
      const deletedPage = deleted.get(target.pageId)
      if (deletedPage) return { status: 'deleted', pageId: target.pageId, title: deletedPage.title }
      const page = active.get(target.pageId)
      if (!page) return { status: 'missing', pageId: target.pageId }
      // Privacy content is never eligible for AI transmission. Unlocking only
      // affects local viewing; it does not grant a model access to the page or
      // to a locked page reached indirectly through a public page reference.
      if (page.locked) return { status: 'locked', pageId: page.id, title: page.title }
      const document = await options.loadDocument(page.id)
      if (!document) return { status: 'missing', pageId: page.id, title: page.title }
      const fragment = findReferencedFragment(document, target)
      if (!fragment) return { status: 'missing', pageId: page.id, title: page.title }
      const assets = await options.loadAssets(page.id)
      return {
        status: 'ready',
        pageId: page.id,
        title: page.title,
        markdown: documentToMarkdown(fragment),
        resources: assets.map((asset) => ({
          id: asset.id,
          kind: resourceKind(asset),
          filename: asset.filename,
          mimeType: asset.mimeType,
          ...(asset.caption ? { description: asset.caption } : {}),
        })),
      }
    },
  })
}
