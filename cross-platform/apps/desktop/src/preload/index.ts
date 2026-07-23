import { contextBridge, ipcRenderer } from 'electron'

export interface NotebookDesktopApi {
  platform: NodeJS.Platform
  versions: Readonly<{ electron: string; chrome: string }>
  notifications: { show(title: string, body: string): Promise<boolean> }
  external: { open(url: string): Promise<void> }
  files: {
    pickOpen(): Promise<Array<{ name: string; dataBase64: string }>>
    pickSave(suggestedName: string, dataBase64: string): Promise<boolean>
  }
  secrets: {
    set(key: string, value: string): Promise<void>
    get(key: string): Promise<string | undefined>
    delete(key: string): Promise<void>
  }
  storage: {
    getInfo(): Promise<{ path: string; source: 'default' | 'environment' | 'command-line' | 'saved' }>
    chooseDataRoot(): Promise<string | undefined>
  }
  legacySftp: {
    pull(settings: { host: string; port: number; username: string; password: string; remotePath: string; fingerprint?: string }): Promise<{ files: Array<{ name: string; dataBase64: string }>; indexHash: string; fingerprint: string }>
    push(settings: { host: string; port: number; username: string; password: string; remotePath: string; fingerprint?: string }, files: Array<{ name: string; dataBase64: string }>, expectedIndexHash: string): Promise<{ fingerprint: string }>
  }
  events: {
    onQuickCapture(callback: () => void): () => void
    onCommandPalette(callback: () => void): () => void
    onFlushRequested(callback: () => void | Promise<void>): () => void
  }
}

const api: NotebookDesktopApi = Object.freeze({
  platform: process.platform,
  versions: Object.freeze({ electron: process.versions.electron, chrome: process.versions.chrome }),
  notifications: Object.freeze({ show: (title: string, body: string) => ipcRenderer.invoke('platform:showNotification', { title, body }) }),
  external: Object.freeze({ open: (url: string) => ipcRenderer.invoke('platform:openExternal', url) }),
  files: Object.freeze({
    pickOpen: () => ipcRenderer.invoke('files:pickOpen'),
    pickSave: (suggestedName: string, dataBase64: string) => ipcRenderer.invoke('files:pickSave', { suggestedName, dataBase64 }),
  }),
  secrets: Object.freeze({
    set: (key: string, value: string) => ipcRenderer.invoke('secrets:set', key, value),
    get: (key: string) => ipcRenderer.invoke('secrets:get', key),
    delete: (key: string) => ipcRenderer.invoke('secrets:delete', key),
  }),
  storage: Object.freeze({
    getInfo: () => ipcRenderer.invoke('storage:getInfo'),
    chooseDataRoot: () => ipcRenderer.invoke('storage:chooseDataRoot'),
  }),
  legacySftp: Object.freeze({
    pull: (settings: Parameters<NotebookDesktopApi['legacySftp']['pull']>[0]) => ipcRenderer.invoke('legacySftp:pull', settings),
    push: (settings: Parameters<NotebookDesktopApi['legacySftp']['push']>[0], files: Parameters<NotebookDesktopApi['legacySftp']['push']>[1], expectedIndexHash: string) => ipcRenderer.invoke('legacySftp:push', settings, files, expectedIndexHash),
  }),
  events: Object.freeze({
    onQuickCapture: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('notebook:quick-capture', listener)
      return () => ipcRenderer.removeListener('notebook:quick-capture', listener)
    },
    onCommandPalette: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('notebook:command-palette', listener)
      return () => ipcRenderer.removeListener('notebook:command-palette', listener)
    },
    onFlushRequested: (callback: () => void | Promise<void>) => {
      const listener = (_event: Electron.IpcRendererEvent, requestId: string) => {
        void Promise.resolve(callback()).then(
          () => ipcRenderer.send('renderer:flush-complete', requestId),
          (error: unknown) => ipcRenderer.send('renderer:flush-complete', requestId, error instanceof Error ? error.message : '保存失败'),
        )
      }
      ipcRenderer.on('notebook:flush-request', listener)
      return () => ipcRenderer.removeListener('notebook:flush-request', listener)
    },
  }),
})

contextBridge.exposeInMainWorld('notebookDesktop', api)
