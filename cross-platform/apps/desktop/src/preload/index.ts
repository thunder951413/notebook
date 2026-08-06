import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopUpdateState } from '../updateContract'
import type { AutomationApiState, AutomationBridgeRequest, AutomationBridgeResponse } from '../automationContract'
import type { DesktopAIChatRequest, DesktopAIChatResponse } from '../aiContract'

type DiagnosticEventInput = {
  level: 'info' | 'warning' | 'error'
  category: string
  action: string
  status: 'started' | 'success' | 'failed' | 'cancelled' | 'info'
  message?: string
  durationMs?: number
}
type DiagnosticEntry = DiagnosticEventInput & { id: string; timestamp: string }

export interface NotebookDesktopApi {
  platform: NodeJS.Platform
  versions: Readonly<{ electron: string; chrome: string }>
  notifications: { show(title: string, body: string): Promise<boolean> }
  external: { open(url: string): Promise<void> }
  inputSource: { useAbc(): Promise<boolean> }
  files: {
    pickOpen(): Promise<Array<{ name: string; dataBase64: string }>>
    pickSave(suggestedName: string, dataBase64: string): Promise<boolean>
  }
  clipboard: {
    readImage(): Promise<{ name: string; mimeType: string; dataBase64: string } | undefined>
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
  updates: {
    getState(): Promise<DesktopUpdateState>
    check(): Promise<DesktopUpdateState>
    download(): Promise<DesktopUpdateState>
    install(): Promise<boolean>
    openReleasePage(): Promise<void>
    onStateChanged(callback: (state: DesktopUpdateState) => void): () => void
  }
  diagnostics: {
    record(event: DiagnosticEventInput): Promise<void>
    list(limit?: number): Promise<DiagnosticEntry[]>
    export(): Promise<string | undefined>
    reveal(): Promise<void>
  }
  automation: {
    getState(): Promise<AutomationApiState>
    configure(enabled: boolean, port: number): Promise<AutomationApiState>
    regenerateToken(): Promise<AutomationApiState>
    onRequest(callback: (request: AutomationBridgeRequest) => void): () => void
    respond(response: AutomationBridgeResponse): void
  }
  ai: {
    complete(request: DesktopAIChatRequest): Promise<DesktopAIChatResponse>
    cancel(requestId: string): Promise<void>
    setKey(provider: DesktopAIChatRequest['provider'], baseUrl: string, value: string): Promise<void>
    hasKey(provider: DesktopAIChatRequest['provider'], baseUrl: string): Promise<boolean>
    deleteKey(provider: DesktopAIChatRequest['provider'], baseUrl: string): Promise<void>
  }
  legacySftp: {
    test(settings: { host: string; port: number; username: string; remotePath: string; fingerprint?: string; password?: string; privateKeyPath?: string; privateKeyPassphrase?: string }): Promise<{ fingerprint: string; remotePath: string; remotePathExists: boolean; latencyMs: number }>
    pull(settings: { host: string; port: number; username: string; remotePath: string; fingerprint?: string; password?: string; privateKeyPath?: string; privateKeyPassphrase?: string }, options?: { metadataOnly?: boolean; knownObjectHashes?: string[]; knownNoteSignatures?: Array<{ noteID: string; signature: string }>; sessionId?: string }): Promise<{ files: Array<{ name: string; data: Uint8Array }>; indexHash: string; fingerprint: string; objectHashes: string[]; reusedObjectCount: number; reusedNoteIds: string[]; sessionId: string }>
    push(settings: { host: string; port: number; username: string; remotePath: string; fingerprint?: string; password?: string; privateKeyPath?: string; privateKeyPassphrase?: string }, files: Array<{ name: string; data: Uint8Array }>, expectedIndexHash: string, options?: { knownObjectHashes?: string[]; sessionId?: string }): Promise<{ fingerprint: string; sessionId: string }>
    release(sessionId: string): Promise<void>
    helper(settings: { host: string; port: number; username: string; remotePath: string; fingerprint?: string; password?: string; privateKeyPath?: string; privateKeyPassphrase?: string }, operation: 'export-tar' | 'import-tar' | 'verify' | 'gc', input?: Uint8Array): Promise<{ ok: boolean; data?: Uint8Array; message?: string }>
  }
  webdav: {
    test(settings: { baseUrl: string; username: string; appPassword: string; remotePath: string; syncPassword?: string }): Promise<{ ok: boolean; remotePathExists: boolean; latencyMs: number; message: string }>
    pull(settings: { baseUrl: string; username: string; appPassword: string; remotePath: string; syncPassword?: string }, knownSeqs: Record<string, number>): Promise<{ entries: Array<{ seq: number; ts: string; op: 'upsert' | 'delete'; type: string; id: string; ver: number; hash?: string; payload: Record<string, unknown>; deviceId: string }>; fingerprint: string }>
    objectGet(settings: { baseUrl: string; username: string; appPassword: string; remotePath: string; syncPassword?: string }, hash: string): Promise<Uint8Array>
    push(settings: { baseUrl: string; username: string; appPassword: string; remotePath: string; syncPassword?: string }, deviceId: string, entries: Array<{ ts: string; op: 'upsert' | 'delete'; type: string; id: string; ver: number; hash?: string; payload: Record<string, unknown> }>, objects: Array<{ hash: string; data: Uint8Array }>): Promise<{ firstSeq: number; count: number }>
  }
  events: {
    onQuickCapture(callback: () => void): () => void
    onCommandPalette(callback: () => void): () => void
    onUpdateCenter(callback: () => void): () => void
    onFlushRequested(callback: () => void | Promise<void>): () => void
  }
}

const api: NotebookDesktopApi = Object.freeze({
  platform: process.platform,
  versions: Object.freeze({ electron: process.versions.electron, chrome: process.versions.chrome }),
  notifications: Object.freeze({ show: (title: string, body: string) => ipcRenderer.invoke('platform:showNotification', { title, body }) }),
  external: Object.freeze({ open: (url: string) => ipcRenderer.invoke('platform:openExternal', url) }),
  inputSource: Object.freeze({ useAbc: () => ipcRenderer.invoke('platform:useAbcInputSource') }),
  files: Object.freeze({
    pickOpen: () => ipcRenderer.invoke('files:pickOpen'),
    pickSave: (suggestedName: string, dataBase64: string) => ipcRenderer.invoke('files:pickSave', { suggestedName, dataBase64 }),
  }),
  clipboard: Object.freeze({
    readImage: () => ipcRenderer.invoke('clipboard:readImage'),
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
  updates: Object.freeze({
    getState: () => ipcRenderer.invoke('updates:getState'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    openReleasePage: () => ipcRenderer.invoke('updates:openReleasePage'),
    onStateChanged: (callback: (state: DesktopUpdateState) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: DesktopUpdateState) => callback(state)
      ipcRenderer.on('notebook:update-state', listener)
      return () => ipcRenderer.removeListener('notebook:update-state', listener)
    },
  }),
  diagnostics: Object.freeze({
    record: (event: DiagnosticEventInput) => ipcRenderer.invoke('diagnostics:record', event),
    list: (limit?: number) => ipcRenderer.invoke('diagnostics:list', limit),
    export: () => ipcRenderer.invoke('diagnostics:export'),
    reveal: () => ipcRenderer.invoke('diagnostics:reveal'),
  }),
  automation: Object.freeze({
    getState: () => ipcRenderer.invoke('automation:getState'),
    configure: (enabled: boolean, port: number) => ipcRenderer.invoke('automation:configure', { enabled, port }),
    regenerateToken: () => ipcRenderer.invoke('automation:regenerateToken'),
    onRequest: (callback: (request: AutomationBridgeRequest) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, request: AutomationBridgeRequest) => callback(request)
      ipcRenderer.on('notebook:automation-request', listener)
      return () => ipcRenderer.removeListener('notebook:automation-request', listener)
    },
    respond: (response: AutomationBridgeResponse) => ipcRenderer.send('automation:response', response),
  }),
  ai: Object.freeze({
    complete: (request: DesktopAIChatRequest) => ipcRenderer.invoke('ai:complete', request),
    cancel: (requestId: string) => ipcRenderer.invoke('ai:cancel', requestId),
    setKey: (provider: DesktopAIChatRequest['provider'], baseUrl: string, value: string) => ipcRenderer.invoke('ai:key:set', { provider, baseUrl, value }),
    hasKey: (provider: DesktopAIChatRequest['provider'], baseUrl: string) => ipcRenderer.invoke('ai:key:has', { provider, baseUrl }),
    deleteKey: (provider: DesktopAIChatRequest['provider'], baseUrl: string) => ipcRenderer.invoke('ai:key:delete', { provider, baseUrl }),
  }),
  legacySftp: Object.freeze({
    test: (settings: Parameters<NotebookDesktopApi['legacySftp']['test']>[0]) => ipcRenderer.invoke('legacySftp:test', settings),
    pull: (settings: Parameters<NotebookDesktopApi['legacySftp']['pull']>[0], options?: Parameters<NotebookDesktopApi['legacySftp']['pull']>[1]) => ipcRenderer.invoke('legacySftp:pull', settings, options),
    push: (settings: Parameters<NotebookDesktopApi['legacySftp']['push']>[0], files: Parameters<NotebookDesktopApi['legacySftp']['push']>[1], expectedIndexHash: string, options?: Parameters<NotebookDesktopApi['legacySftp']['push']>[3]) => ipcRenderer.invoke('legacySftp:push', settings, files, expectedIndexHash, options),
    release: (sessionId: string) => ipcRenderer.invoke('legacySftp:release', sessionId),
    helper: (settings: Parameters<NotebookDesktopApi['legacySftp']['helper']>[0], operation: 'export-tar' | 'import-tar' | 'verify' | 'gc', input?: Uint8Array) => ipcRenderer.invoke('legacySftp:helper', settings, operation, input),
  }),
  webdav: Object.freeze({
    test: (settings: Parameters<NotebookDesktopApi['webdav']['test']>[0]) => ipcRenderer.invoke('webdav:test', settings),
    pull: (settings: Parameters<NotebookDesktopApi['webdav']['pull']>[0], knownSeqs: Record<string, number>) => ipcRenderer.invoke('webdav:pull', settings, knownSeqs),
    objectGet: (settings: Parameters<NotebookDesktopApi['webdav']['objectGet']>[0], hash: string) => ipcRenderer.invoke('webdav:object:get', settings, hash),
    push: (settings: Parameters<NotebookDesktopApi['webdav']['push']>[0], deviceId: string, entries: Parameters<NotebookDesktopApi['webdav']['push']>[2], objects: Parameters<NotebookDesktopApi['webdav']['push']>[3]) => ipcRenderer.invoke('webdav:push', settings, deviceId, entries, objects),
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
    onUpdateCenter: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('notebook:update-center', listener)
      return () => ipcRenderer.removeListener('notebook:update-center', listener)
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
