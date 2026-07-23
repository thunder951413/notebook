export {}

declare global {
  interface Window {
    notebookDesktop?: {
      platform: string
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
      events: { onQuickCapture(callback: () => void): () => void }
    }
  }
}
