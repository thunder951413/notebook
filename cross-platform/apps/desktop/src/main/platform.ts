import { app, dialog, ipcMain, Notification, safeStorage, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { saveDataRoot, type DataRootSelection } from './dataRoot'
import { pullLegacyRepository, pushLegacyRepository, type LegacySftpFile, type LegacySshConnection } from './legacySftp'

const MAX_IMPORT_BYTES = 100 * 1024 * 1024
const execFileAsync = promisify(execFile)

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

export function flushRenderer(contents: WebContents, timeoutMs = 5_000): Promise<void> {
  if (contents.isDestroyed()) return Promise.resolve()
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
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
    contents.send('notebook:flush-request', requestId)
  })
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

export function registerPlatformHandlers(options: { defaultUserDataPath: string; dataRootSource: DataRootSelection['source'] }) {
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
    assertTrustedSender(event); requireEncryption()
    const store = await readCredentialStore()
    store[key] = safeStorage.encryptString(value).toString('base64')
    await writeCredentialStore(store)
  })
  ipcMain.handle('secrets:get', async (event, key: string) => {
    assertTrustedSender(event); requireEncryption()
    const encrypted = (await readCredentialStore())[key]
    return encrypted ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : undefined
  })
  ipcMain.handle('secrets:delete', async (event, key: string) => {
    assertTrustedSender(event)
    const store = await readCredentialStore()
    delete store[key]
    await writeCredentialStore(store)
  })

  ipcMain.handle('legacySftp:pull', async (event, settings: LegacySshConnection) => {
    assertTrustedSender(event)
    return pullLegacyRepository(settings)
  })
  ipcMain.handle('legacySftp:push', async (event, settings: LegacySshConnection, files: LegacySftpFile[], expectedIndexHash: string) => {
    assertTrustedSender(event)
    return pushLegacyRepository(settings, files, expectedIndexHash)
  })
}
