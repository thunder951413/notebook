import { z } from 'zod'

const legacyDate = z.number().finite()
const uuid = z.string().uuid()

export const textSpanSchema = z.object({
  text: z.string(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  link: z.string().optional(),
}).passthrough()

export const assetReferenceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['image', 'audio', 'video', 'file']),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  width: z.number().optional(),
  height: z.number().optional(),
  duration: z.number().optional(),
  createdAt: legacyDate,
  sidecarFiles: z.array(z.string()).default([]),
}).passthrough()

export const blockSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  level: z.number().int().min(1).max(6).optional(),
  checked: z.boolean().optional(),
  text: z.array(textSpanSchema).optional(),
  table: z.object({
    rows: z.array(z.array(z.string())),
    columnWidths: z.array(z.number()).optional(),
    rowHeights: z.array(z.number()).optional(),
  }).optional(),
  asset: assetReferenceSchema.optional(),
}).passthrough()

export const noteEnvelopeSchema = z.object({
  contractFixtureVersion: z.number().int().optional(),
  noteID: uuid,
  deviceID: z.string(),
  exportedAt: legacyDate,
  currentVersion: z.number().int().nonnegative(),
  currentSnapshot: z.object({
    metadata: z.object({
      id: uuid,
      title: z.string(),
      createdAt: legacyDate,
      updatedAt: legacyDate,
      folderID: uuid.nullish(),
      folderName: z.string().default(''),
      reminderAt: legacyDate.nullish(),
      recurrenceRule: z.string().default('none'),
      version: z.number().int().nonnegative(),
      tagIDs: z.array(uuid).default([]),
      viewMode: z.string().default('editor'),
      itemType: z.enum(['note', 'todo']).default('note'),
      todoDueAt: legacyDate.nullish(),
      todoCompletedAt: legacyDate.nullish(),
      todoIsImportant: z.boolean().default(false),
      todoOrder: z.number().int().default(0),
      linkedNoteIDs: z.array(uuid).default([]),
    }).passthrough(),
    document: z.object({
      schemaVersion: z.string(),
      source: z.string(),
      blocks: z.array(blockSchema),
      notebookNextTiptap: z.record(z.string(), z.unknown()).optional(),
    }).passthrough(),
    assets: z.array(z.object({
      reference: assetReferenceSchema,
      relativeFilePath: z.string(),
      sidecarRelativePaths: z.array(z.string()).default([]),
    })).default([]),
    todoSteps: z.array(z.object({
      id: uuid,
      noteID: uuid,
      text: z.string(),
      checked: z.boolean(),
      order: z.number().int(),
      createdAt: legacyDate,
    })).default([]),
  }),
  history: z.array(z.object({
    id: uuid, noteID: uuid, version: z.number().int().nonnegative(), recordedAt: legacyDate, updatedAt: legacyDate,
    title: z.string(), authorDeviceID: z.string(), contentHash: z.string(), snapshot: z.unknown(),
  })).default([]),
  syncState: z.unknown().optional(),
})

export const libraryEnvelopeSchema = z.object({
  contractFixtureVersion: z.number().int().optional(),
  exportedAt: legacyDate,
  deviceID: z.string(),
  folders: z.array(z.object({
    id: uuid,
    name: z.string(),
    sortOrder: z.number().int(),
    isSystem: z.boolean(),
    createdAt: legacyDate.optional(),
    folderType: z.enum(['noteFolder', 'todoList', 'encryptedFolder']).default('noteFolder'),
    updatedAt: legacyDate.optional(),
  })),
  tags: z.array(z.object({
    id: uuid,
    name: z.string(),
    color: z.string(),
    createdAt: legacyDate,
    updatedAt: legacyDate.optional(),
  })),
  encryptedData: z.unknown().optional(),
  deletedFolders: z.array(z.unknown()).default([]),
  deletedTags: z.array(z.unknown()).default([]),
})

export type LegacyNoteEnvelope = z.infer<typeof noteEnvelopeSchema>
export type LegacyLibraryEnvelope = z.infer<typeof libraryEnvelopeSchema>

export const noteIndexSchema = z.object({
  contractFixtureVersion: z.number().int().optional(),
  generatedAt: legacyDate,
  deviceID: z.string(),
  entries: z.array(z.object({ noteID: uuid, version: z.number().int(), contentHash: z.string(), historyCount: z.number().int() })),
  deletedEntries: z.array(z.object({ noteID: uuid, deletedAt: legacyDate, deletedByDeviceID: z.string() })).default([]),
})

export const readingPositionsSchema = z.object({
  contractFixtureVersion: z.number().int().optional(),
  schemaVersion: z.number().int(),
  exportedAt: z.string(),
  deviceID: z.string(),
  positions: z.array(z.object({
    noteID: uuid,
    anchorUTF16Offset: z.number().int().nonnegative(),
    viewportOffsetFraction: z.number().min(0).max(1),
    updatedAt: z.string(),
    deviceID: z.string(),
  })),
})

export type LegacyNoteIndex = z.infer<typeof noteIndexSchema>
export type LegacyReadingPositions = z.infer<typeof readingPositionsSchema>

export interface LegacyEncryptedFolder {
  id: string
  name: string
  order: number
}

export interface LegacyEncryptedData {
  encryptedFolders: LegacyEncryptedFolder[]
  encryptedNoteIDs: string[]
  noteToFolderMapping: Record<string, string>
}

const isoDate = z.string().min(1)
const migratedTextSpanSchema = z.object({
  text: z.string(), bold: z.boolean(), italic: z.boolean(), underline: z.boolean(), strikethrough: z.boolean(),
  textColor: z.string().nullish(), backgroundColor: z.string().nullish(), link: z.string().nullish(),
  fontFamily: z.string().nullish(), fontSize: z.number().nullish(), kern: z.number().nullish(), baselineOffset: z.number().nullish(),
  paragraphStyle: z.object({
    alignment: z.number().nullish(), lineSpacing: z.number().nullish(), paragraphSpacing: z.number().nullish(),
    paragraphSpacingBefore: z.number().nullish(), firstLineHeadIndent: z.number().nullish(), headIndent: z.number().nullish(), tailIndent: z.number().nullish(),
  }).nullish(),
}).passthrough()

export const migratedDocumentSchema = z.object({
  schemaVersion: z.string(), source: z.string(),
  blocks: z.array(z.object({
    id: z.string(), type: z.string(), text: z.array(migratedTextSpanSchema).nullish(), level: z.number().nullish(),
    listStyle: z.string().nullish(), order: z.number().nullish(), checked: z.boolean().nullish(), indent: z.number().nullish(),
    asset: z.object({ id: z.string(), kind: z.enum(['image', 'audio', 'video', 'file']), filename: z.string(), mimeType: z.string(), width: z.number().nullish(), height: z.number().nullish(), duration: z.number().nullish(), createdAt: isoDate.nullish(), sidecarFiles: z.array(z.string()).default([]) }).nullish(),
    table: z.object({ rows: z.array(z.array(z.string())), columnWidths: z.array(z.number()), rowHeights: z.array(z.number()) }).nullish(),
  }).passthrough()),
}).passthrough()

export const migrationManifestSchema = z.object({
  schemaVersion: z.string(), exportedAt: isoDate,
  notes: z.array(z.object({
    id: uuid, title: z.string(), createdAt: isoDate, updatedAt: isoDate, folderID: uuid.nullish(), folderName: z.string(),
    reminderAt: isoDate.nullish(), recurrenceRule: z.string(), version: z.number().int(), tagIDs: z.array(uuid), viewMode: z.string(),
    deletedAt: isoDate.nullish(), originalFolderID: uuid.nullish(), originalFolderName: z.string().nullish(), blockCount: z.number().int(),
    assetCount: z.number().int(), documentPath: z.string(), itemType: z.string().nullish(), todoDueAt: isoDate.nullish(),
    todoCompletedAt: isoDate.nullish(), todoIsImportant: z.boolean().nullish(), todoOrder: z.number().int().nullish(), linkedNoteIDs: z.array(uuid).nullish(),
  }).passthrough()),
  folders: z.array(z.object({ id: uuid, name: z.string(), sortOrder: z.number().int(), isSystem: z.boolean(), createdAt: isoDate.nullish(), folderType: z.string().nullish() }).passthrough()),
  tags: z.array(z.object({ id: uuid, name: z.string(), color: z.string(), createdAt: isoDate }).passthrough()),
  todoSteps: z.array(z.object({ id: uuid, noteID: uuid, text: z.string(), checked: z.boolean(), order: z.number().int(), createdAt: isoDate })).nullish(),
}).passthrough()

export type MigrationManifest = z.infer<typeof migrationManifestSchema>
export type MigratedDocumentPayload = z.infer<typeof migratedDocumentSchema>
