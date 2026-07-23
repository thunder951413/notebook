import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import plist from '../apps/renderer/node_modules/plist/index.js'
import { strFromU8, strToU8, unzipSync, zipSync } from '../apps/renderer/node_modules/fflate/esm/index.mjs'

const args = new Map(Array.from({ length: Math.floor(process.argv.slice(2).length / 2) }, (_, index) => {
  const offset = index * 2 + 2
  return [process.argv[offset], process.argv[offset + 1]]
}))
const input = args.get('--backup')
const output = args.get('--output')
const legacyBackup = args.get('--legacy-backup')
const defaultsDomain = args.get('--defaults-domain') ?? 'yy.Notebook'
if (!input || !output) throw new Error('Usage: node repair-private-notebooks.mjs --backup <Notebook Next zip> --output <zip> [--legacy-backup <old export zip>] [--defaults-domain yy.Notebook]')

const files = unzipSync(new Uint8Array(await readFile(input)))
const rootFile = files['notebook-next.json']
if (!rootFile) throw new Error('Notebook Next backup is missing notebook-next.json')
const payload = JSON.parse(strFromU8(rootFile))
if (payload?.schemaVersion !== 1 || !payload.bundle) throw new Error('Unsupported Notebook Next backup')

const exportedDefaults = execFileSync('defaults', ['export', defaultsDomain, '-'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
const defaults = plist.parse(exportedDefaults)
const folderBytes = defaults.encrypted_folders
const folders = JSON.parse(Buffer.from(folderBytes).toString('utf8'))
const archivedEncryptedData = legacyBackup ? plist.parse(execFileSync('unzip', ['-p', legacyBackup, 'Config/EncryptedData.plist'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })) : undefined
let encryptedNoteIDs = Array.isArray(archivedEncryptedData?.encryptedNoteIDs) ? archivedEncryptedData.encryptedNoteIDs : Array.isArray(defaults.encrypted_note_ids) ? defaults.encrypted_note_ids : []
const noteToFolderMapping = archivedEncryptedData?.noteToFolderMapping && typeof archivedEncryptedData.noteToFolderMapping === 'object'
  ? archivedEncryptedData.noteToFolderMapping
  : defaults.note_to_encrypted_folder && typeof defaults.note_to_encrypted_folder === 'object' ? defaults.note_to_encrypted_folder : {}
if (!Array.isArray(folders) || !folders.every((folder) => typeof folder?.id === 'string' && typeof folder?.name === 'string')) throw new Error('Invalid encrypted_folders preference')

const bundle = payload.bundle
const workspaceId = bundle.notebooks[0]?.workspaceId
if (!workspaceId) throw new Error('Backup does not contain a workspace')
const pageIds = new Set(bundle.pages.map((page) => page.id))
const missingPageIds = encryptedNoteIDs.filter((id) => !pageIds.has(id))
if (missingPageIds.length) {
  const archivedManifest = legacyBackup ? JSON.parse(execFileSync('unzip', ['-p', legacyBackup, 'Notes/manifest.json'], { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 })) : undefined
  const archivedPageIds = new Set(archivedManifest?.notes?.map((note) => note.id) ?? [])
  const unexpectedlyMissing = missingPageIds.filter((id) => archivedPageIds.has(id))
  if (unexpectedlyMissing.length) throw new Error(`Backup is missing ${unexpectedlyMissing.length} encrypted pages present in the legacy manifest; refusing a partial repair`)
  encryptedNoteIDs = encryptedNoteIDs.filter((id) => pageIds.has(id))
}
const folderIds = new Set(folders.map((folder) => folder.id))
const invalidMappings = Object.entries(noteToFolderMapping).filter(([noteId, folderId]) => encryptedNoteIDs.includes(noteId) && !folderIds.has(folderId))
if (invalidMappings.length) throw new Error(`Preferences contain ${invalidMappings.length} mappings to missing encrypted folders`)

const now = new Date().toISOString()
const privateNotebookId = `recovered-private-${workspaceId}`
bundle.notebooks = [...bundle.notebooks.filter((notebook) => !notebook.locked), {
  id: privateNotebookId, workspaceId, name: '隐私笔记本', emoji: '🔒', sortOrder: 101, createdAt: now, updatedAt: now, locked: true,
}]
bundle.sections = [
  ...bundle.sections.filter((section) => !folderIds.has(section.id) && section.notebookId !== privateNotebookId),
  ...folders.map((folder) => ({ id: folder.id, notebookId: privateNotebookId, name: folder.name, color: '#8b5a9f', sortOrder: Number(folder.order) || 0, createdAt: now, updatedAt: now })),
]
const encryptedIds = new Set(encryptedNoteIDs)
bundle.pages = bundle.pages.map((page) => encryptedIds.has(page.id) ? {
  ...page,
  sectionId: noteToFolderMapping[page.id] ?? page.sectionId,
  locked: true,
  legacyMetadata: { ...(page.legacyMetadata ?? {}), legacyEncryptedFolderId: noteToFolderMapping[page.id] },
} : page)
payload.exportedAt = now
files['notebook-next.json'] = strToU8(JSON.stringify(payload))
await writeFile(output, zipSync(files, { level: 6 }))
console.log(JSON.stringify({ pages: bundle.pages.length, encryptedPages: encryptedNoteIDs.length, privateFolders: folders.length, mappedPages: Object.keys(noteToFolderMapping).length, output }))
