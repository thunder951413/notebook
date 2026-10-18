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
      /** Dock badge (Tauri shell); absent in Electron. */
      badge?: { set(count: number): Promise<void> }
      /** AI inbox (Tauri shell): files opened with the app, and its global shortcut. */
      inbox?: {
        take(): Promise<Array<{ name: string; dataBase64: string }>>
        /** e.g. "Control+Alt+KeyN"; null unbinds. Rejects when the system refuses it. */
        setShortcut(accelerator: string | null): Promise<void>
      }
      /** One-time settings hand-over from the old Electron app (Tauri shell). */
      legacy?: { take(): Promise<{ webdav?: { baseUrl: string; username: string; remotePath: string }; appPassword?: string; syncPassword?: string; githubToken?: string } | undefined> }
      external: { open(url: string): Promise<void> }
      inputSource: { useAbc(): Promise<boolean> }
      files: {
        pickOpen(): Promise<Array<{ name: string; dataBase64: string }>>
        pickSave(suggestedName: string, dataBase64: string): Promise<boolean>
      }
      clipboard: {
        readImage(): Promise<{ name: string; mimeType: string; dataBase64: string } | undefined>
        /** Everything copied right now: Finder files, image, HTML, text (Tauri shell). */
        snapshot?(): Promise<{
          changeCount: number
          files: Array<{ name: string; dataBase64: string }>
          skipped: string[]
          image?: { name: string; mimeType: string; dataBase64: string } | null
          html?: string | null
          text?: string | null
        }>
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
        record(event: { level: 'info' | 'warning' | 'error'; category: string; action: string; status: 'started' | 'success' | 'failed' | 'cancelled' | 'info'; message?: string; durationMs?: number; operationId?: string; resource?: { type: string; id?: string }; errorType?: string; errorCode?: string; stack?: string[] }): Promise<void>
        list(limit?: number): Promise<Array<{ id: string; timestamp: string; sessionId: string; appVersion: string; platform: string; arch: string; level: 'info' | 'warning' | 'error'; category: string; action: string; status: 'started' | 'success' | 'failed' | 'cancelled' | 'info'; message?: string; durationMs?: number; operationId?: string; resource?: { type: string; id?: string }; errorType?: string; errorCode?: string; stack?: string[] }>>
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
        test(settings: { host: string; port: number; username: string; remotePath: string; fingerprint?: string; password?: string; privateKeyPath?: string; privateKeyPassphrase?: string }): Promise<{ fingerprint: string; remotePath: string; remotePathExists: boolean; latencyMs: number }>
        pull(settings: { host: string; port: number; username: string; remotePath: string; fingerprint?: string; password?: string; privateKeyPath?: string; privateKeyPassphrase?: string }, options?: { metadataOnly?: boolean; knownObjectHashes?: string[]; knownNoteSignatures?: Array<{ noteID: string; signature: string }>; sessionId?: string }): Promise<{ files: Array<{ name: string; data: Uint8Array }>; indexHash: string; fingerprint: string; objectHashes: string[]; reusedObjectCount: number; reusedNoteIds: string[]; sessionId: string }>
        push(settings: { host: string; port: number; username: string; remotePath: string; fingerprint?: string; password?: string; privateKeyPath?: string; privateKeyPassphrase?: string }, files: Array<{ name: string; data: Uint8Array }>, expectedIndexHash: string, options?: { knownObjectHashes?: string[]; sessionId?: string }): Promise<{ fingerprint: string; sessionId: string }>
        release(sessionId: string): Promise<void>
        helper(settings: { host: string; port: number; username: string; remotePath: string; fingerprint?: string; password?: string; privateKeyPath?: string; privateKeyPassphrase?: string }, operation: 'export-tar' | 'import-tar' | 'verify' | 'gc', input?: Uint8Array): Promise<{ ok: boolean; data?: Uint8Array; message?: string }>
      }
      webdav: {
        test(settings: { baseUrl: string; username: string; appPassword: string; remotePath: string; syncPassword?: string }, requestId: string): Promise<{ ok: boolean; remotePathExists: boolean; latencyMs: number; message: string }>
        pull(settings: { baseUrl: string; username: string; appPassword: string; remotePath: string; syncPassword?: string }, knownSeqs: Record<string, number>, requestId: string): Promise<{ entries: Array<{ seq: number; ts: string; op: 'upsert' | 'delete'; type: string; id: string; ver: number; hash?: string; payload: Record<string, unknown>; deviceId: string }>; fingerprint: string; devices?: string[]; resetDevices?: string[]; warnings?: string[]; blocked?: Array<{ deviceId: string; code: 'journal-corrupt' | 'head-corrupt' | 'journal-truncated' | 'journal-missing' | 'journal-too-large'; message: string; knownSeq: number; headLastSeq?: number; journalLastSeq?: number }> }>
        objectGet(settings: { baseUrl: string; username: string; appPassword: string; remotePath: string; syncPassword?: string }, hash: string, requestId: string): Promise<Uint8Array>
        push(settings: { baseUrl: string; username: string; appPassword: string; remotePath: string; syncPassword?: string }, deviceId: string, entries: Array<{ ts: string; op: 'upsert' | 'delete'; type: string; id: string; ver: number; hash?: string; payload: Record<string, unknown> }>, objects: Array<{ hash: string; data: Uint8Array }>, requestId: string, minSeq?: number): Promise<{ firstSeq: number; count: number }>
        /** Repair: keep a copy of a damaged own journal, remove it, and report the sequence floor to continue above. */
        rebuildJournal(settings: { baseUrl: string; username: string; appPassword: string; remotePath: string; syncPassword?: string }, deviceId: string, requestId: string): Promise<{ backup?: string; floorSeq: number }>
        cancel(requestId: string): Promise<void>
        /** WebDAV requests this app sent in the last 30 minutes (Tauri shell). */
        recentRequestCount?(): Promise<number>
      }
      events: {
        onQuickCapture(callback: () => void): () => void
        onCommandPalette(callback: () => void): () => void
        onUpdateCenter(callback: () => void): () => void
        /** Global shortcut, menu item or files opened with the app (Tauri shell). */
        onInbox?(callback: (source: 'shortcut' | 'menu' | 'open') => void): () => void
        onFlushRequested(callback: () => void | Promise<void>): () => void
      }
    }
  }
}
