import { app, BrowserWindow, dialog, globalShortcut, Menu, nativeImage, shell, Tray } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { flushRenderer, registerPlatformHandlers } from './platform'
import { resolveDataRoot } from './dataRoot'
import electronUpdater from 'electron-updater'

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let quitAfterFlush = false
let flushInProgress = false
const { autoUpdater } = electronUpdater
const defaultUserDataPath = app.getPath('userData')
const dataRoot = resolveDataRoot(defaultUserDataPath)
app.setPath('userData', dataRoot.path)
const hasUpdateMetadata = () => app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'))

const isAllowedExternalUrl = (value: string) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 920,
    minHeight: 620,
    title: 'Notebook Next',
    backgroundColor: '#f7f5f8',
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
  const icon = nativeImage.createFromPath(join(__dirname, '../renderer/notebook-icon.svg')).resize({ width: 18, height: 18 })
  if (icon.isEmpty()) return
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Notebook Next')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '快速记录', click: () => showMainWindow(true) },
    { label: '打开 Notebook', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]))
  tray.on('click', () => showMainWindow())
}

function configureUpdates() {
  if (!hasUpdateMetadata()) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('error', (error) => console.error('Update check failed', error))
  void autoUpdater.checkForUpdatesAndNotify().catch((error) => console.error('Update metadata unavailable', error))
  setInterval(() => { void autoUpdater.checkForUpdatesAndNotify().catch((error) => console.error('Update metadata unavailable', error)) }, 10 * 60 * 1000)
}

app.whenReady().then(() => {
  registerPlatformHandlers({ defaultUserDataPath, dataRootSource: dataRoot.source })
  createWindow()
  createTray()
  configureUpdates()
  const menu = Menu.buildFromTemplate([
    { label: 'Notebook', submenu: [{ role: 'about' }, { label: '命令面板…', accelerator: process.platform === 'darwin' ? 'Command+P' : 'Control+Shift+P', click: () => { showMainWindow(); mainWindow?.webContents.send('notebook:command-palette') } }, { label: '检查更新', enabled: hasUpdateMetadata(), click: () => { if (hasUpdateMetadata()) void autoUpdater.checkForUpdatesAndNotify().catch((error) => console.error('Update metadata unavailable', error)) } }, { type: 'separator' }, { role: 'quit' }] },
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
  globalShortcut.unregisterAll()
  tray?.destroy()
})
