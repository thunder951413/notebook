import { z } from 'zod'

export interface RemoteSyncChange {
  cursor: number
  entityType: string
  entityId: string
  version: number
  operation: string
  payload: Record<string, unknown>
}

export interface RemoteApplyResult {
  cursor: number
  conflicts: Array<{ entityType: string; entityId: string; pageIds: string[] }>
}

const recordSchema = z.record(z.string(), z.unknown())
const isoSchema = z.string().min(1)
const notebookSchema = z.object({ id: z.string().min(1), workspaceId: z.string().min(1), name: z.string(), sortOrder: z.number(), createdAt: isoSchema, updatedAt: isoSchema }).passthrough()
const sectionSchema = z.object({ id: z.string().min(1), notebookId: z.string().min(1), name: z.string(), sortOrder: z.number(), createdAt: isoSchema, updatedAt: isoSchema }).passthrough()
const pageSchema = z.object({ id: z.string().min(1), workspaceId: z.string().min(1), kind: z.enum(['document', 'task']), title: z.string(), preview: z.string(), favorite: z.boolean(), createdAt: isoSchema, updatedAt: isoSchema, syncStatus: z.enum(['local', 'pending', 'synced', 'conflict', 'error']) }).passthrough()
const documentSchema = z.object({ pageId: z.string().min(1), schemaVersion: z.number().int().nonnegative(), tiptapJson: recordSchema, updatedAt: isoSchema }).passthrough()
const tagSchema = z.object({ id: z.string().min(1), workspaceId: z.string().min(1), name: z.string(), color: z.string(), createdAt: isoSchema, updatedAt: isoSchema }).passthrough()
const taskStepSchema = z.object({ id: z.string().min(1), pageId: z.string().min(1), text: z.string(), checked: z.boolean(), sortOrder: z.number(), createdAt: isoSchema }).passthrough()
const assetSchema = z.object({ id: z.string().min(1), pageId: z.string().min(1), kind: z.enum(['image', 'audio', 'video', 'file']), filename: z.string(), mimeType: z.string(), createdAt: isoSchema }).passthrough()
const pageLinkSchema = z.object({ id: z.string().min(1), workspaceId: z.string().min(1), sourcePageId: z.string().min(1), targetPageId: z.string().min(1), kind: z.enum(['link', 'mention', 'embed']), createdAt: isoSchema }).passthrough()
const readingPositionSchema = z.object({ id: z.string().min(1), pageId: z.string().min(1), anchorUtf16Offset: z.number().int().nonnegative(), viewportOffsetFraction: z.number(), updatedAt: isoSchema, deviceId: z.string() }).passthrough()
const revisionSchema = z.object({ id: z.string().min(1), pageId: z.string().min(1), document: documentSchema, createdAt: isoSchema, reason: z.enum(['autosave', 'manual', 'restore', 'import']) }).passthrough()
const pageTagSchema = z.object({ pageId: z.string().min(1), tagId: z.string().min(1) }).passthrough()

export function parseRemotePayload(change: RemoteSyncChange) {
  const schemas: Record<string, z.ZodType> = {
    notebook: notebookSchema, section: sectionSchema, page: pageSchema, document: documentSchema,
    tag: tagSchema, task_step: taskStepSchema, asset: assetSchema, page_link: pageLinkSchema,
    reading_position: readingPositionSchema, revision: revisionSchema, page_tag: pageTagSchema,
  }
  const schema = schemas[change.entityType]
  if (!schema) throw new Error(`Unsupported remote entity type: ${change.entityType}`)
  const value = schema.parse(change.payload) as Record<string, unknown>
  const payloadId = change.entityType === 'document' ? value.pageId
    : change.entityType === 'page_tag' ? `${value.pageId}:${value.tagId}`
      : value.id
  if (payloadId !== change.entityId) throw new Error(`Remote ${change.entityType} payload id does not match change id`)
  return value
}

export function remapAssetReferences(value: unknown, assetIds: Map<string, string>): unknown {
  if (typeof value === 'string') {
    let result = value
    for (const [sourceId, targetId] of assetIds) result = result.replaceAll(`notebook-asset:${sourceId}`, `notebook-asset:${targetId}`)
    return assetIds.get(result) ?? result
  }
  if (Array.isArray(value)) return value.map((item) => remapAssetReferences(item, assetIds))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, remapAssetReferences(item, assetIds)]))
}
