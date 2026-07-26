export {}

declare global {
  type DesktopUpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error'
  interface DesktopUpdateState {
    status: DesktopUpdateStatus
    currentVersion: string
    availableVersion?: string
    releaseName?: string
    releaseDate?: string
    releaseNotes?: string
    releaseUrl: string
    checkedAt?: string
    progressPercent?: number
    transferredBytes?: number
    totalBytes?: number
    canAutoInstall: boolean
    requiresAuthentication?: boolean
    message?: string
  }

  interface Window {
    notebookDesktop?: {
      platform: string
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
        record(event: { level: 'info' | 'warning' | 'error'; category: string; action: string; status: 'started' | 'success' | 'failed' | 'cancelled' | 'info'; message?: string; durationMs?: number }): Promise<void>
        list(limit?: number): Promise<Array<{ id: string; timestamp: string; level: 'info' | 'warning' | 'error'; category: string; action: string; status: 'started' | 'success' | 'failed' | 'cancelled' | 'info'; message?: string; durationMs?: number }>>
        export(): Promise<string | undefined>
        reveal(): Promise<void>
      }
      automation: {
        getState(): Promise<{ enabled: boolean; port: number; baseUrl: string; token?: string; rendererReady: boolean }>
        configure(enabled: boolean, port: number): Promise<{ enabled: boolean; port: number; baseUrl: string; token?: string; rendererReady: boolean }>
        regenerateToken(): Promise<{ enabled: boolean; port: number; baseUrl: string; token?: string; rendererReady: boolean }>
        onRequest(callback: (request: { id: string; operation: 'guide' | 'openapi' | 'list-pages' | 'get-page' | 'create-proposal' | 'list-proposals' | 'get-proposal'; payload: unknown }) => void): () => void
        respond(response: { id: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }): void
      }
      ai: {
        complete(request: {
          requestId: string
          provider: 'openai' | 'deepseek' | 'custom'
          baseUrl: string
          model: string
          messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
        }): Promise<{
          content: string
          model?: string
          usage?: { promptTokens?: number; completionTokens?: number }
        }>
        cancel(requestId: string): Promise<void>
        setKey(provider: 'openai' | 'deepseek' | 'custom', baseUrl: string, value: string): Promise<void>
        hasKey(provider: 'openai' | 'deepseek' | 'custom', baseUrl: string): Promise<boolean>
        deleteKey(provider: 'openai' | 'deepseek' | 'custom', baseUrl: string): Promise<void>
      }
      legacySftp: {
        test(settings: { host: string; port: number; username: string; password: string; remotePath: string; fingerprint?: string }): Promise<{ fingerprint: string; remotePath: string; remotePathExists: boolean; latencyMs: number }>
        pull(settings: { host: string; port: number; username: string; password: string; remotePath: string; fingerprint?: string }, options?: { knownObjectHashes?: string[]; knownNoteSignatures?: Array<{ noteID: string; signature: string }> }): Promise<{ files: Array<{ name: string; dataBase64: string }>; indexHash: string; fingerprint: string; objectHashes: string[]; reusedObjectCount: number; reusedNoteIds: string[] }>
        push(settings: { host: string; port: number; username: string; password: string; remotePath: string; fingerprint?: string }, files: Array<{ name: string; dataBase64: string }>, expectedIndexHash: string): Promise<{ fingerprint: string }>
      }
      events: {
        onQuickCapture(callback: () => void): () => void
        onCommandPalette(callback: () => void): () => void
        onUpdateCenter(callback: () => void): () => void
        onFlushRequested(callback: () => void | Promise<void>): () => void
      }
    }
  }
}
