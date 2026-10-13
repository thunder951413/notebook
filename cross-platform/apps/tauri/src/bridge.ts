/**
 * `window.notebookDesktop` for the Tauri shell.
 *
 * The shared renderer was written against the Electron preload API. This
 * module implements the same contract on top of Tauri commands, so the
 * renderer runs unchanged. It must be imported before the renderer.
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

type Desktop = NonNullable<Window['notebookDesktop']>
type UpdateState = Awaited<ReturnType<Desktop['updates']['getState']>>
type LegacyImport = NonNullable<Awaited<ReturnType<NonNullable<Desktop['legacy']>['take']>>>


function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

/** Commands reject with a plain string; the renderer expects Error objects. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/** Synchronous subscribe/unsubscribe over Tauri's async `listen`. */
function channel<T>(event: string) {
  const callbacks = new Set<(payload: T) => void>()
  void listen<T>(event, ({ payload }) => {
    for (const callback of callbacks) callback(payload)
  })
  return (callback: (payload: T) => void) => {
    callbacks.add(callback)
    return () => { callbacks.delete(callback) }
  }
}

// Flush requests come before window hide, reload and quit. Exactly one answer
// goes back per request, after every registered saver has finished.
const flushCallbacks = new Set<() => void | Promise<void>>()
void listen<string>('notebook:flush-request', ({ payload: requestId }) => {
  void Promise.all([...flushCallbacks].map((callback) => Promise.resolve().then(callback))).then(
    () => invoke('renderer_flush_complete', { requestId }),
    (error: unknown) => invoke('renderer_flush_complete', { requestId, error: error instanceof Error ? error.message : '保存失败' }),
  )
})

const automationUnavailable = () => Promise.reject(new Error('新版桌面应用暂不提供本地 AI 接口'))
const legacyUnavailable = () => Promise.reject(new Error('新版桌面应用不再支持旧版 SSH/SFTP 同步，请使用坚果云 WebDAV 同步'))

const onQuickCapture = channel<null>('notebook:quick-capture')
const onCommandPalette = channel<null>('notebook:command-palette')
const onUpdateCenter = channel<null>('notebook:update-center')
const onUpdateState = channel<UpdateState>('notebook:update-state')

const api: Desktop = Object.freeze({
  platform: 'darwin',
  versions: Object.freeze({ electron: '', chrome: '' }),
  notifications: { show: (title: string, body: string) => call<boolean>('notify', { title, body }) },
  badge: { set: (count: number) => call<void>('set_badge', { count: Math.max(0, Math.round(count)) }) },
  legacy: { take: async () => (await call<LegacyImport | null>('legacy_import_take')) ?? undefined },
  external: { open: (url: string) => call<void>('open_external', { url }) },
  inputSource: { useAbc: () => call<boolean>('input_source_use_abc') },
  files: {
    pickOpen: () => call<Array<{ name: string; dataBase64: string }>>('files_pick_open'),
    pickSave: (suggestedName: string, dataBase64: string) => call<boolean>('files_pick_save', { suggestedName, dataBase64 }),
  },
  clipboard: {
    readImage: async () => (await call<{ name: string; mimeType: string; dataBase64: string } | null>('clipboard_read_image')) ?? undefined,
  },
  secrets: {
    set: (key: string, value: string) => call<void>('secrets_set', { key, value }),
    get: async (key: string) => (await call<string | null>('secrets_get', { key })) ?? undefined,
    delete: (key: string) => call<void>('secrets_delete', { key }),
  },
  storage: {
    getInfo: () => call<{ path: string; source: 'default' }>('storage_info'),
    chooseDataRoot: () => Promise.reject(new Error('新版桌面应用的数据由系统统一管理，暂不支持更换数据目录')),
  },
  updates: {
    getState: () => call<UpdateState>('update_state'),
    check: () => call<UpdateState>('update_check'),
    download: () => call<UpdateState>('update_download'),
    install: () => call<boolean>('update_install'),
    openReleasePage: () => call<void>('update_open_release'),
    onStateChanged: (callback: (state: UpdateState) => void) => onUpdateState(callback),
  },

  diagnostics: {
    record: (event) => call<void>('diagnostics_record', { event }),
    list: (limit?: number) => call<Awaited<ReturnType<Desktop['diagnostics']['list']>>>('diagnostics_list', { limit: limit ?? null }),
    export: async () => (await call<string | null>('diagnostics_export')) ?? undefined,
    reveal: () => call<void>('diagnostics_reveal'),
  },
  automation: {
    getState: async () => ({ enabled: false, port: 0, baseUrl: '', rendererReady: true }),
    configure: automationUnavailable,
    regenerateToken: automationUnavailable,
    onRequest: () => () => undefined,
    respond: () => undefined,
  },
  ai: {
    complete: (request) => call<Awaited<ReturnType<Desktop['ai']['complete']>>>('ai_complete', { request }),
    cancel: (requestId: string) => call<void>('ai_cancel', { requestId }),
    setKey: (provider, baseUrl, value) => call<void>('ai_key_set', { provider, baseUrl, value }),
    hasKey: (provider, baseUrl) => call<boolean>('ai_key_has', { provider, baseUrl }),
    deleteKey: (provider, baseUrl) => call<void>('ai_key_delete', { provider, baseUrl }),
  },
  legacySftp: {
    test: legacyUnavailable,
    pull: legacyUnavailable,
    push: legacyUnavailable,
    release: async () => undefined,
    helper: legacyUnavailable,
  },
  webdav: {
    test: (settings, requestId) => call<Awaited<ReturnType<Desktop['webdav']['test']>>>('webdav_test', { settings, requestId }),
    pull: (settings, knownSeqs, requestId) => call<Awaited<ReturnType<Desktop['webdav']['pull']>>>('webdav_pull', { settings, knownSeqs, requestId }),
    objectGet: async (settings, hash, requestId) => new Uint8Array(await call<ArrayBuffer>('webdav_object_get', { settings, hash, requestId })),
    push: (settings, deviceId, entries, objects, requestId, minSeq) => call<Awaited<ReturnType<Desktop['webdav']['push']>>>('webdav_push', {
      settings,
      deviceId,
      entries,
      objects: objects.map((object) => ({ hash: object.hash, dataBase64: bytesToBase64(object.data) })),
      requestId,
      minSeq: minSeq ?? null,
    }),
    cancel: (requestId: string) => call<void>('webdav_cancel', { requestId }),
    recentRequestCount: () => call<number>('webdav_recent_requests'),
  },
  events: {
    onQuickCapture: (callback: () => void) => onQuickCapture(() => callback()),
    onCommandPalette: (callback: () => void) => onCommandPalette(() => callback()),
    onUpdateCenter: (callback: () => void) => onUpdateCenter(() => callback()),
    onFlushRequested: (callback: () => void | Promise<void>) => {
      flushCallbacks.add(callback)
      return () => { flushCallbacks.delete(callback) }
    },
  },
})

Object.defineProperty(window, 'notebookDesktop', { value: api, configurable: false, writable: false })
document.documentElement.dataset.shell = 'tauri'

// WebKit may evict website data under storage pressure unless the origin is
// marked persistent. The library also lives in the cloud, but unsynced edits
// only exist here.
void navigator.storage?.persist?.().then((persisted) => {
  void api.diagnostics.record({ level: persisted ? 'info' : 'warning', category: 'storage', action: 'persist', status: persisted ? 'success' : 'failed', message: persisted ? 'persistent storage granted' : 'persistent storage not granted' })
}).catch(() => undefined)
