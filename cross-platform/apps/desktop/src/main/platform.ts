import { app, clipboard, dialog, ipcMain, Notification, safeStorage, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { saveDataRoot, type DataRootSelection } from './dataRoot'
import { pullLegacyRepository, pushLegacyRepository, releaseLegacySession, runRepositoryHelper, testLegacyConnection, type LegacySftpFile, type LegacySftpHelperResult, type LegacySftpPullOptions, type LegacySftpPushOptions, type LegacySshConnection } from './legacySftp'
import { appendWebdavJournal, getWebdavObject, pullWebdavJournals, putWebdavObject, testWebdavConnection, type WebdavConnection, type WebdavJournalEntry } from './webdav'
import { appendDiagnosticEvent, diagnosticErrorDetails, diagnosticLogPath, exportDiagnosticEvents, readDiagnosticEvents, type DiagnosticEventInput } from './diagnostics'

const MAX_IMPORT_BYTES = 100 * 1024 * 1024
const WEBDAV_OPERATION_TIMEOUT_MS = 60_000
const execFileAsync = promisify(execFile)

async function diagnoseOperation<T>(options: {
  category: string
  action: string
  operationId?: string
  resource?: DiagnosticEventInput['resource']
  summarize?: (result: T) => string | undefined
}, operation: () => Promise<T>): Promise<T> {
  const operationId = options.operationId ?? randomUUID()
  const startedAt = Date.now()
  void appendDiagnosticEvent({ level: 'info', category: options.category, action: options.action, status: 'started', operationId, resource: options.resource })
  try {
    const result = await operation()
    void appendDiagnosticEvent({
      level: 'info', category: options.category, action: options.action, status: 'success', operationId,
      resource: options.resource, durationMs: Date.now() - startedAt, message: options.summarize?.(result),
    })
    return result
  } catch (error) {
    void appendDiagnosticEvent({
      level: 'error', category: options.category, action: options.action, status: 'failed', operationId,
      resource: options.resource, durationMs: Date.now() - startedAt, ...diagnosticErrorDetails(error),
    })
    throw error
  }
}

function macInputSourceHelperPath() {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', 'notebook-input-source')
    : join(app.getAppPath(), 'build', 'notebook-input-source')
}

function assertTrustedSender(event: IpcMainInvokeEvent) {
  const url = event.senderFrame?.url ?? event.sender.getURL()
  if (url.startsWith('file://')) return
  if (!app.isPackaged) {
    const origin = new URL(url).origin
    if (origin === 'http://127.0.0.1:5173' || origin === 'http://localhost:5173') return
  }
  throw new Error(`Rejected IPC from untrusted renderer origin`)
}

const credentialsPath = () => join(app.getPath('userData'), 'credentials.v1.json')

async function atomicWriteFile(target: string, data: string | Uint8Array, mode?: number) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  await mkdir(dirname(target), { recursive: true })
  try {
    const handle = await open(temporary, 'w', mode)
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
    try {
      const directory = await open(dirname(target), 'r')
      try { await directory.sync() } finally { await directory.close() }
    } catch {
      // Directory handles cannot be flushed on Windows. The temporary file was
      // still flushed before the atomic rename.
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

// Renderer shutdown includes durable drafts/reading positions plus a bounded
// best-effort sync, so leave enough room for that handshake without waiting
// indefinitely on a broken renderer or network.
export function flushRenderer(contents: WebContents, timeoutMs = 8_000, operationId: string = randomUUID()): Promise<void> {
  if (contents.isDestroyed()) return Promise.resolve()
  const requestId = operationId
  const startedAt = Date.now()
  void appendDiagnosticEvent({ level: 'info', category: 'storage', action: 'renderer-flush', status: 'started', operationId: requestId })
  const flush = new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      ipcMain.removeListener('renderer:flush-complete', listener)
    }
    const listener = (event: Electron.IpcMainEvent, responseId: string, error?: string) => {
      if (event.sender !== contents || responseId !== requestId) return
      cleanup()
      if (error) reject(new Error(error))
      else resolve()
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('保存编辑内容超时，已取消退出或重启'))
    }, timeoutMs)
    ipcMain.on('renderer:flush-complete', listener)
    try {
      contents.send('notebook:flush-request', requestId)
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
  void flush.then(() => appendDiagnosticEvent({
    level: 'info', category: 'storage', action: 'renderer-flush', status: 'success',
    operationId: requestId, durationMs: Date.now() - startedAt,
  }), (error) => appendDiagnosticEvent({
    level: 'error', category: 'storage', action: 'renderer-flush', status: 'failed',
    operationId: requestId, durationMs: Date.now() - startedAt, ...diagnosticErrorDetails(error),
  }))
  return flush
}

async function readCredentialStore(): Promise<Record<string, string>> {
  try { return JSON.parse(await readFile(credentialsPath(), 'utf8')) as Record<string, string> }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

async function writeCredentialStore(store: Record<string, string>) {
  await atomicWriteFile(credentialsPath(), JSON.stringify(store), 0o600)
}

function requireEncryption() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Operating-system credential encryption is unavailable')
}

export async function getStoredSecret(key: string): Promise<string | undefined> {
  requireEncryption()
  const encrypted = (await readCredentialStore())[key]
  return encrypted ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : undefined
}

export async function setStoredSecret(key: string, value: string): Promise<void> {
  requireEncryption()
  const store = await readCredentialStore()
  store[key] = safeStorage.encryptString(value).toString('base64')
  await writeCredentialStore(store)
}

export async function deleteStoredSecret(key: string): Promise<void> {
  const store = await readCredentialStore()
  delete store[key]
  await writeCredentialStore(store)
}

function assertWebdavRequestId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error('WebDAV 请求标识无效')
}

async function withWebdavDeadline<T>(requestId: string, requests: Map<string, AbortController>, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  assertWebdavRequestId(requestId)
  if (requests.has(requestId)) throw new Error('WebDAV 请求标识重复')
  const controller = new AbortController()
  requests.set(requestId, controller)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('WebDAV 操作超时'))
  }, WEBDAV_OPERATION_TIMEOUT_MS)
  try {
    return await operation(controller.signal)
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(timedOut ? 'WebDAV 操作超时（60 秒）' : 'WebDAV 操作已取消', { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timer)
    requests.delete(requestId)
  }
}

export function registerPlatformHandlers(options: { defaultUserDataPath: string; dataRootSource: DataRootSelection['source'] }) {
  const webdavRequests = new Map<string, AbortController>()
  ipcMain.handle('platform:showNotification', (event, value: { title: string; body: string }) => {
    assertTrustedSender(event)
    if (!Notification.isSupported()) return false
    new Notification({ title: value.title.slice(0, 160), body: value.body.slice(0, 2_000) }).show()
    return true
  })

  ipcMain.handle('platform:openExternal', async (event, value: string) => {
    assertTrustedSender(event)
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only HTTP(S) links may be opened externally')
    await shell.openExternal(url.toString())
  })

  ipcMain.handle('platform:useAbcInputSource', async (event) => {
    assertTrustedSender(event)
    if (process.platform !== 'darwin') return false
    try {
      await execFileAsync(macInputSourceHelperPath(), [], { timeout: 1_500, windowsHide: true })
      return true
    } catch (error) {
      console.warn('Unable to switch the macOS input source to ABC', error)
      return false
    }
  })

  ipcMain.handle('files:pickOpen', async (event) => {
    assertTrustedSender(event)
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Notebook imports', extensions: ['md', 'markdown', 'txt', 'html', 'htm', 'json', 'zip', 'nbx'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled) return []
    return Promise.all(result.filePaths.map(async (path) => {
      const data = await readFile(path)
      if (data.byteLength > MAX_IMPORT_BYTES) throw new Error(`${basename(path)} exceeds the 100 MB import limit`)
      return { name: basename(path), dataBase64: data.toString('base64') }
    }))
  })

  ipcMain.handle('files:pickSave', async (event, value: { suggestedName: string; dataBase64: string }) => {
    assertTrustedSender(event)
    const result = await dialog.showSaveDialog({ defaultPath: value.suggestedName })
    if (result.canceled || !result.filePath) return false
    const data = Buffer.from(value.dataBase64, 'base64')
    if (data.byteLength > MAX_IMPORT_BYTES) throw new Error('Export exceeds the 100 MB bridge limit')
    await atomicWriteFile(result.filePath, data)
    return true
  })

  ipcMain.handle('clipboard:readImage', (event) => {
    assertTrustedSender(event)
    const image = clipboard.readImage()
    if (image.isEmpty()) return undefined
    const png = image.toPNG()
    if (!png.byteLength || png.byteLength > MAX_IMPORT_BYTES) return undefined
    return {
      name: `粘贴图片-${new Date().toISOString().replaceAll(':', '-')}.png`,
      mimeType: 'image/png',
      dataBase64: png.toString('base64'),
    }
  })

  ipcMain.handle('storage:getInfo', (event) => {
    assertTrustedSender(event)
    return { path: app.getPath('userData'), source: options.dataRootSource }
  })

  ipcMain.handle('storage:chooseDataRoot', async (event) => {
    assertTrustedSender(event)
    const result = await dialog.showOpenDialog({ title: '选择 Notebook Next 数据目录', properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths[0]) return undefined
    await flushRenderer(event.sender)
    const path = saveDataRoot(options.defaultUserDataPath, result.filePaths[0], app.getPath('userData'))
    app.relaunch()
    app.quit()
    return path
  })

  ipcMain.handle('secrets:set', async (event, key: string, value: string) => {
    assertTrustedSender(event)
    if (key.startsWith('ai-provider-key:')) throw new Error('AI API Key 只能通过专用安全接口修改')
    await setStoredSecret(key, value)
  })
  ipcMain.handle('secrets:get', async (event, key: string) => {
    assertTrustedSender(event)
    if (key.startsWith('ai-provider-key:')) throw new Error('AI API Key 不能返回到界面进程')
    return getStoredSecret(key)
  })
  ipcMain.handle('secrets:delete', async (event, key: string) => {
    assertTrustedSender(event)
    if (key.startsWith('ai-provider-key:')) throw new Error('AI API Key 只能通过专用安全接口修改')
    await deleteStoredSecret(key)
  })

  ipcMain.handle('diagnostics:record', async (event, value: DiagnosticEventInput) => {
    assertTrustedSender(event)
    await appendDiagnosticEvent(value)
  })
  ipcMain.handle('diagnostics:list', async (event, limit?: number) => {
    assertTrustedSender(event)
    return readDiagnosticEvents(limit)
  })
  ipcMain.handle('diagnostics:export', async (event) => {
    assertTrustedSender(event)
    const result = await dialog.showSaveDialog({
      title: '导出 Notebook 诊断日志',
      defaultPath: `notebook-diagnostics-${new Date().toISOString().slice(0, 10)}.jsonl`,
      filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }],
    })
    if (result.canceled || !result.filePath) return undefined
    const entries = await exportDiagnosticEvents()
    await atomicWriteFile(result.filePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 0o600)
    return result.filePath
  })
  ipcMain.handle('diagnostics:reveal', async (event) => {
    assertTrustedSender(event)
    await appendDiagnosticEvent({ level: 'info', category: 'diagnostics', action: 'reveal-log', status: 'success' })
    shell.showItemInFolder(diagnosticLogPath())
  })

  ipcMain.handle('legacySftp:pull', async (event, settings: LegacySshConnection, pullOptions?: LegacySftpPullOptions) => {
    assertTrustedSender(event)
    return diagnoseOperation({
      category: 'sync', action: 'legacy-pull',
      summarize: (result) => `${result.files.length} files · ${result.reusedObjectCount} objects reused`,
    }, () => pullLegacyRepository(settings, pullOptions))
  })
  ipcMain.handle('legacySftp:test', async (event, settings: LegacySshConnection) => {
    assertTrustedSender(event)
    return diagnoseOperation({ category: 'sync', action: 'legacy-test' }, () => testLegacyConnection(settings))
  })
  ipcMain.handle('legacySftp:push', async (event, settings: LegacySshConnection, files: LegacySftpFile[], expectedIndexHash: string, pushOptions?: LegacySftpPushOptions) => {
    assertTrustedSender(event)
    return diagnoseOperation({ category: 'sync', action: 'legacy-push', summarize: () => `${files.length} files` }, () => pushLegacyRepository(settings, files, expectedIndexHash, pushOptions))
  })
  ipcMain.handle('legacySftp:release', async (event, sessionId: string) => {
    assertTrustedSender(event)
    await releaseLegacySession(sessionId)
  })
  ipcMain.handle('legacySftp:helper', async (event, settings: LegacySshConnection, operation: 'export-tar' | 'import-tar' | 'verify' | 'gc', input?: Uint8Array): Promise<LegacySftpHelperResult> => {
    assertTrustedSender(event)
    return diagnoseOperation({ category: 'sync', action: `legacy-${operation}` }, () => runRepositoryHelper(settings, operation, input))
  })

  ipcMain.handle('webdav:test', async (event, settings: WebdavConnection, requestId: string) => {
    assertTrustedSender(event)
    return diagnoseOperation({ category: 'sync', action: 'webdav-test', operationId: requestId },
      () => withWebdavDeadline(requestId, webdavRequests, (signal) => testWebdavConnection(settings, signal)))
  })
  ipcMain.handle('webdav:pull', async (event, settings: WebdavConnection, knownSeqs: Record<string, number>, requestId: string) => {
    assertTrustedSender(event)
    return diagnoseOperation({ category: 'sync', action: 'webdav-pull', operationId: requestId, summarize: (result) => `${result.entries.length} entries` },
      () => withWebdavDeadline(requestId, webdavRequests, (signal) => pullWebdavJournals(settings, knownSeqs, signal)))
  })
  ipcMain.handle('webdav:object:get', async (event, settings: WebdavConnection, hash: string, requestId: string) => {
    assertTrustedSender(event)
    return diagnoseOperation({ category: 'sync', action: 'webdav-object-get', operationId: requestId, resource: { type: 'object', id: hash } },
      () => withWebdavDeadline(requestId, webdavRequests, (signal) => getWebdavObject(settings, hash, signal)))
  })
  ipcMain.handle('webdav:push', async (event, settings: WebdavConnection, deviceId: string, entries: Array<Omit<WebdavJournalEntry, 'seq'>>, objects: Array<{ hash: string; data: Uint8Array }>, requestId: string) => {
    assertTrustedSender(event)
    return diagnoseOperation({ category: 'sync', action: 'webdav-push', operationId: requestId, summarize: (result) => `${result.count} entries · ${objects.length} objects` },
      () => withWebdavDeadline(requestId, webdavRequests, async (signal) => {
        for (const object of objects) await putWebdavObject(settings, object.hash, object.data, signal)
        return appendWebdavJournal(settings, deviceId, entries, signal)
      }))
  })
  ipcMain.handle('webdav:cancel', (event, requestId: string) => {
    assertTrustedSender(event)
    assertWebdavRequestId(requestId)
    webdavRequests.get(requestId)?.abort(new Error('渲染进程取消 WebDAV 请求'))
  })
}
