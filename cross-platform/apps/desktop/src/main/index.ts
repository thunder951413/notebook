import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { join } from 'node:path'
import { deleteStoredSecret, flushRenderer, getStoredSecret, registerPlatformHandlers, setStoredSecret } from './platform'
import { resolveDataRoot } from './dataRoot'
import { DesktopUpdateService } from './updater'
import { appendDiagnosticEvent } from './diagnostics'
import { AutomationApiServer } from './automationServer'
import type { AutomationBridgeResponse } from '../automationContract'
import { aiProviderCredentialKey, completeAIChat } from './aiProvider'
import type { DesktopAIChatRequest } from '../aiContract'

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let quitAfterFlush = false
let flushInProgress = false
const defaultUserDataPath = app.getPath('userData')
const dataRoot = resolveDataRoot(defaultUserDataPath)
app.setPath('userData', dataRoot.path)
const updateService = new DesktopUpdateService(async () => getStoredSecret('github-release-token'), async () => {
  await Promise.all(BrowserWindow.getAllWindows().map((window) => flushRenderer(window.webContents)))
  quitAfterFlush = true
})
const automationApi = new AutomationApiServer(
  () => mainWindow?.webContents,
  {
    get: () => getStoredSecret('automation-api-token'),
    set: (value) => setStoredSecret('automation-api-token', value),
  },
)
const aiRequests = new Map<string, AbortController>()

const isAllowedExternalUrl = (value: string) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function createWindow() {
  let lastRendererRecoveryAt = 0
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 920,
    minHeight: 620,
    title: 'Notebook Next',
    backgroundColor: '#f7f5f8',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 16 } }
      : { titleBarOverlay: { color: '#00000000', symbolColor: '#737078', height: 38 } }),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (current && new URL(url).origin !== new URL(current).origin) event.preventDefault()
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('Notebook renderer process exited', details)
    void appendDiagnosticEvent({ level: 'error', category: 'renderer', action: 'process-gone', status: 'failed', message: details.reason })
    if (window.isDestroyed()) return
    const now = Date.now()
    if (now - lastRendererRecoveryAt > 30_000) {
      lastRendererRecoveryAt = now
      setTimeout(() => { if (!window.isDestroyed()) window.webContents.reload() }, 250)
      return
    }
    dialog.showErrorBox('Notebook 界面进程异常退出', '笔记数据仍保存在本机。请重新打开应用；如果问题持续出现，请记录当时正在操作的页面。')
  })
  let closeAfterFlush = false
  let closeFlushInProgress = false
  window.on('close', (event) => {
    if (quitAfterFlush || closeAfterFlush) return
    event.preventDefault()
    if (closeFlushInProgress) return
    closeFlushInProgress = true
    void flushRenderer(window.webContents).then(() => {
      closeAfterFlush = true
      window.close()
    }).catch((error) => {
      closeFlushInProgress = false
      dialog.showErrorBox('无法安全关闭窗口', error instanceof Error ? error.message : '编辑内容尚未保存')
    })
  })
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
  mainWindow = window

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

function showMainWindow(quickCapture = false) {
  if (!mainWindow) createWindow()
  mainWindow?.show()
  mainWindow?.focus()
  if (quickCapture) mainWindow?.webContents.send('notebook:quick-capture')
}

function createTray() {
  const iconName = process.platform === 'darwin' ? 'notebook-trayTemplate.png' : 'notebook-icon.svg'
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'tray', iconName)
    : join(__dirname, '../renderer', iconName)
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) return
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  tray = new Tray(process.platform === 'darwin' ? icon : icon.resize({ width: 18, height: 18 }))
  tray.setToolTip('Notebook Next')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '快速记录', click: () => showMainWindow(true) },
    { label: '打开 Notebook', click: () => showMainWindow() },
    { label: '检查更新…', click: () => { showMainWindow(); mainWindow?.webContents.send('notebook:update-center'); void updateService.check(true) } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]))
  tray.on('click', () => showMainWindow())
}

app.whenReady().then(() => {
  registerPlatformHandlers({ defaultUserDataPath, dataRootSource: dataRoot.source })
  void appendDiagnosticEvent({ level: 'info', category: 'app', action: 'started', status: 'success', message: `Notebook ${app.getVersion()} · ${process.platform} ${process.arch}` })
  ipcMain.handle('updates:getState', () => updateService.getState())
  ipcMain.handle('updates:check', () => updateService.check(true))
  ipcMain.handle('updates:download', () => updateService.download())
  ipcMain.handle('updates:install', () => updateService.install())
  ipcMain.handle('updates:openReleasePage', () => updateService.openReleasePage())
  const assertMainRenderer = (sender: Electron.WebContents) => {
    if (!mainWindow || sender !== mainWindow.webContents) throw new Error('Rejected IPC from untrusted renderer')
  }
  ipcMain.handle('automation:getState', (event) => { assertMainRenderer(event.sender); return automationApi.state(true) })
  ipcMain.handle('automation:configure', (event, value: { enabled: boolean; port: number }) => { assertMainRenderer(event.sender); return automationApi.configure(Boolean(value.enabled), value.port) })
  ipcMain.handle('automation:regenerateToken', (event) => { assertMainRenderer(event.sender); return automationApi.regenerateToken() })
  ipcMain.on('automation:response', (event, response: AutomationBridgeResponse) => { assertMainRenderer(event.sender); automationApi.handleRendererResponse(response) })
  ipcMain.handle('ai:complete', async (event, request: DesktopAIChatRequest) => {
    assertMainRenderer(event.sender)
    if (!request?.requestId || aiRequests.has(request.requestId)) throw new Error('AI 请求标识无效或重复')
    const controller = new AbortController()
    aiRequests.set(request.requestId, controller)
    const startedAt = Date.now()
    try {
      const response = await completeAIChat(request, fetch, getStoredSecret, controller.signal)
      void appendDiagnosticEvent({
        level: 'info',
        category: 'ai',
        action: 'complete',
        status: 'success',
        message: `模型 ${response.model ?? request.model}`,
        durationMs: Date.now() - startedAt,
      })
      return response
    } catch (error) {
      const cancelled = controller.signal.aborted
      void appendDiagnosticEvent({
        level: cancelled ? 'info' : 'error',
        category: 'ai',
        action: 'complete',
        status: cancelled ? 'cancelled' : 'failed',
        message: `服务商 ${String(request?.provider ?? 'unknown').slice(0, 30)} · 模型 ${String(request?.model ?? 'unknown').slice(0, 100)}`,
        durationMs: Date.now() - startedAt,
      })
      throw error
    } finally {
      aiRequests.delete(request.requestId)
    }
  })
  ipcMain.handle('ai:cancel', (event, requestId: string) => {
    assertMainRenderer(event.sender)
    aiRequests.get(requestId)?.abort()
  })
  ipcMain.handle('ai:key:set', async (event, value: { provider: DesktopAIChatRequest['provider']; baseUrl: string; value: string }) => {
    assertMainRenderer(event.sender)
    const secret = value?.value?.trim()
    if (!secret || secret.length > 20_000) throw new Error('AI API Key 无效')
    await setStoredSecret(aiProviderCredentialKey(value.provider, value.baseUrl), secret)
  })
  ipcMain.handle('ai:key:has', async (event, value: { provider: DesktopAIChatRequest['provider']; baseUrl: string }) => {
    assertMainRenderer(event.sender)
    return Boolean(await getStoredSecret(aiProviderCredentialKey(value.provider, value.baseUrl)))
  })
  ipcMain.handle('ai:key:delete', async (event, value: { provider: DesktopAIChatRequest['provider']; baseUrl: string }) => {
    assertMainRenderer(event.sender)
    await deleteStoredSecret(aiProviderCredentialKey(value.provider, value.baseUrl))
  })
  createWindow()
  createTray()
  void automationApi.initialize().catch((error) => {
    void appendDiagnosticEvent({ level: 'error', category: 'automation', action: 'server-start', status: 'failed', message: error instanceof Error ? error.message : '无法启动本地 AI 接口' })
  })
  updateService.configure()
  const menu = Menu.buildFromTemplate([
    { label: 'Notebook', submenu: [{ role: 'about' }, { label: '命令面板…', accelerator: process.platform === 'darwin' ? 'Command+P' : 'Control+Shift+P', click: () => { showMainWindow(); mainWindow?.webContents.send('notebook:command-palette') } }, { label: '检查更新…', click: () => { showMainWindow(); mainWindow?.webContents.send('notebook:update-center'); void updateService.check(true) } }, { type: 'separator' }, { role: 'quit' }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ])
  Menu.setApplicationMenu(menu)
  globalShortcut.register('CommandOrControl+Shift+N', () => {
    showMainWindow(true)
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitAfterFlush) return
  event.preventDefault()
  if (flushInProgress) return
  flushInProgress = true
  void Promise.all(BrowserWindow.getAllWindows().map((window) => flushRenderer(window.webContents))).then(() => {
    quitAfterFlush = true
    app.quit()
  }).catch((error) => {
    flushInProgress = false
    dialog.showErrorBox('无法安全退出', error instanceof Error ? error.message : '编辑内容尚未保存')
  })
})

app.on('will-quit', () => {
  void appendDiagnosticEvent({ level: 'info', category: 'app', action: 'stopped', status: 'success' })
  globalShortcut.unregisterAll()
  tray?.destroy()
  for (const controller of aiRequests.values()) controller.abort()
  aiRequests.clear()
  void automationApi.stop()
})
