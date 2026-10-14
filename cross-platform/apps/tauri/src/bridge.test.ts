import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Tauri's IPC is replaced by spies: `invoke` records commands, `listen`
// captures event handlers so tests can emit events from the "Rust side".
const invoke = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>()
const handlers = new Map<string, Array<(event: { payload: unknown }) => void>>()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (command: string, args?: Record<string, unknown>) => invoke(command, args) }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(event, [...(handlers.get(event) ?? []), handler])
    return Promise.resolve(() => undefined)
  },
}))

const emit = (event: string, payload: unknown) => handlers.get(event)?.forEach((handler) => handler({ payload }))
const desktop = () => window.notebookDesktop!

beforeAll(async () => {
  await import('./bridge')
})

afterEach(() => {
  invoke.mockReset()
})

describe('Tauri bridge (window.notebookDesktop)', () => {
  it('installs a frozen API and marks the shell', () => {
    expect(desktop()).toBeDefined()
    expect(Object.isFrozen(desktop())).toBe(true)
    expect(document.documentElement.dataset.shell).toBe('tauri')
    expect(() => { (window as { notebookDesktop?: unknown }).notebookDesktop = undefined }).toThrow()
  })

  it('maps commands and turns string rejections into Error objects', async () => {
    invoke.mockResolvedValueOnce(null)
    await expect(desktop().secrets.get('webdav-password')).resolves.toBeUndefined()
    expect(invoke).toHaveBeenLastCalledWith('secrets_get', { key: 'webdav-password' })
    invoke.mockRejectedValueOnce('钥匙串不可用')
    const error = await desktop().secrets.set('k', 'v').catch((value: unknown) => value)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('钥匙串不可用')
    invoke.mockResolvedValueOnce(undefined)
    await desktop().badge!.set(2.6)
    expect(invoke).toHaveBeenLastCalledWith('set_badge', { count: 3 })
  })

  it('sends WebDAV objects as base64 and returns object bytes as Uint8Array', async () => {
    invoke.mockResolvedValueOnce({ firstSeq: 1, count: 1 })
    const settings = { baseUrl: 'https://dav.example.com/dav/', username: 'u', appPassword: 'p', remotePath: 'notebook' }
    await desktop().webdav.push(settings, 'device', [], [{ hash: 'h', data: new TextEncoder().encode('笔记') }], 'request-1')
    expect(invoke).toHaveBeenLastCalledWith('webdav_push', {
      settings, deviceId: 'device', entries: [], objects: [{ hash: 'h', dataBase64: btoa(String.fromCharCode(...new TextEncoder().encode('笔记'))) }], requestId: 'request-1', minSeq: null,
    })
    invoke.mockResolvedValueOnce(new Uint8Array([1, 2, 3]).buffer)
    const bytes = await desktop().webdav.objectGet(settings, 'h', 'request-2')
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect([...bytes]).toEqual([1, 2, 3])
  })

  it('exposes the local automation API and relays renderer requests and answers', async () => {
    invoke.mockResolvedValueOnce({ enabled: true, port: 47831, baseUrl: 'http://127.0.0.1:47831', token: 't', rendererReady: true })
    await expect(desktop().automation.configure(true, 47831)).resolves.toMatchObject({ enabled: true })
    expect(invoke).toHaveBeenLastCalledWith('automation_configure', { enabled: true, port: 47831 })
    const seen: unknown[] = []
    const unsubscribe = desktop().automation.onRequest((request) => seen.push(request))
    emit('notebook:automation-request', { id: 'a', operation: 'guide', payload: {} })
    unsubscribe()
    emit('notebook:automation-request', { id: 'b', operation: 'guide', payload: {} })
    expect(seen).toEqual([{ id: 'a', operation: 'guide', payload: {} }])
    invoke.mockResolvedValueOnce(undefined)
    desktop().automation.respond({ id: 'a', ok: true, result: { text: 'ok' } })
    expect(invoke).toHaveBeenLastCalledWith('automation_respond', { response: { id: 'a', ok: true, result: { text: 'ok' } } })
  })

  it('answers each flush request once, after every saver finished, and reports failures', async () => {
    const order: string[] = []
    const stop = desktop().events.onFlushRequested(async () => { await Promise.resolve(); order.push('saved') })
    invoke.mockImplementation(async (command) => { order.push(command); return undefined })
    emit('notebook:flush-request', 'flush-1')
    await vi.waitFor(() => expect(order).toEqual(['saved', 'renderer_flush_complete']))
    expect(invoke).toHaveBeenLastCalledWith('renderer_flush_complete', { requestId: 'flush-1' })
    stop()
    const failing = desktop().events.onFlushRequested(() => { throw new Error('磁盘已满') })
    emit('notebook:flush-request', 'flush-2')
    await vi.waitFor(() => expect(invoke).toHaveBeenLastCalledWith('renderer_flush_complete', { requestId: 'flush-2', error: '磁盘已满' }))
    failing()
  })

  it('keeps unsupported Electron-only features explicit', async () => {
    await expect(desktop().legacySftp.test({} as never)).rejects.toThrow(/SSH\/SFTP/)
    await expect(desktop().storage.chooseDataRoot()).rejects.toThrow()
  })
})
