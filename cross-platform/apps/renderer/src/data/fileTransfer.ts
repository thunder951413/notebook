import { base64ToBytes, bytesToBase64, type ImportFile } from './transfer'
import { documentToHtml, documentToMarkdown } from '../editor/extensions'
import { encryptBackup } from '../crypto/encryptedBackup'
import { recordDiagnosticEvent } from '../diagnostics/diagnostics'

export interface FileTransferContext {
  activeSectionId: string
  currentPageTitle: string
  currentPageDocument: Record<string, unknown> | undefined
  importFiles: (files: ImportFile[], sectionId: string) => Promise<number>
  exportWorkspace: () => Promise<Uint8Array>
  onMessage: (message: string | undefined) => void
  onEncryptedImportRequest: (request: { file: ImportFile; rest: ImportFile[] }) => void
  /** Hidden file input used when the desktop bridge is unavailable. */
  browserFileInput: { current: HTMLInputElement | null }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  Object.assign(document.createElement('a'), { href: url, download: filename }).click()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export async function runImport(context: FileTransferContext, files: ImportFile[]) {
  try {
    const encryptedIndex = files.findIndex((file) => file.name.toLocaleLowerCase().endsWith('.nbx'))
    if (encryptedIndex >= 0) {
      const file = files[encryptedIndex]!
      context.onEncryptedImportRequest({ file, rest: files.filter((_, index) => index !== encryptedIndex) })
      return
    }
    const count = await context.importFiles(files, context.activeSectionId)
    context.onMessage(`已导入 ${count} 个页面`)
  } catch (error) {
    const message = error instanceof Error ? error.message : '导入失败'
    context.onMessage(message)
    recordDiagnosticEvent({ level: 'error', category: 'data', action: 'import', status: 'failed', message })
  }
}

export function chooseImport(context: FileTransferContext) {
  if (window.notebookDesktop) {
    void window.notebookDesktop.files.pickOpen().then((files) => runImport(context, files.map((file) => ({ name: file.name, data: base64ToBytes(file.dataBase64) }))))
  } else context.browserFileInput.current?.click()
}

export async function runExport(context: FileTransferContext) {
  const data = await context.exportWorkspace()
  const name = `notebook-next-${new Date().toISOString().slice(0, 10)}.zip`
  if (window.notebookDesktop) {
    const saved = await window.notebookDesktop.files.pickSave(name, bytesToBase64(data))
    context.onMessage(saved ? '备份已导出' : undefined)
    recordDiagnosticEvent({ level: 'info', category: 'data', action: 'save-export', status: saved ? 'success' : 'cancelled' })
    return
  }
  downloadBlob(new Blob([data as BlobPart], { type: 'application/zip' }), name)
  context.onMessage('备份已导出')
}

export async function runEncryptedExport(context: FileTransferContext, passphrase: string) {
  const data = await encryptBackup(await context.exportWorkspace(), passphrase)
  const name = `notebook-next-${new Date().toISOString().slice(0, 10)}.nbx`
  if (window.notebookDesktop) {
    const saved = await window.notebookDesktop.files.pickSave(name, bytesToBase64(data))
    if (!saved) {
      recordDiagnosticEvent({ level: 'info', category: 'data', action: 'encrypted-export', status: 'cancelled' })
      return
    }
  }
  else downloadBlob(new Blob([data as BlobPart], { type: 'application/octet-stream' }), name)
  context.onMessage('加密备份已导出')
  recordDiagnosticEvent({ level: 'info', category: 'data', action: 'encrypted-export', status: 'success' })
}

export async function saveCurrentDocument(context: FileTransferContext, format: 'md' | 'html') {
  const documentJson = context.currentPageDocument ?? { type: 'doc', content: [{ type: 'paragraph' }] }
  const text = format === 'md' ? documentToMarkdown(documentJson) : `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeHtml(context.currentPageTitle)}</title><style>body{max-width:820px;margin:40px auto;font:16px/1.7 system-ui}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:8px}</style><body><h1>${escapeHtml(context.currentPageTitle)}</h1>${documentToHtml(documentJson)}</body></html>`
  const bytes = new TextEncoder().encode(text)
  const filename = `${context.currentPageTitle.replace(/[\\/:*?"<>|]/g, '_')}.${format}`
  if (window.notebookDesktop) await window.notebookDesktop.files.pickSave(filename, bytesToBase64(bytes))
  else downloadBlob(new Blob([bytes as BlobPart], { type: format === 'md' ? 'text/markdown' : 'text/html' }), filename)
}
