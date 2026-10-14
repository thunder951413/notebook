import { useEffect, useState } from 'react'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'

type CollaborationStatus = 'loading' | 'offline' | 'connecting' | 'connected' | 'error'

export interface CollaborativeDocumentSession {
  document: Y.Doc
  provider?: HocuspocusProvider
  status: CollaborationStatus
  readOnly?: boolean
  synced?: boolean
}

const collaborationUrl = import.meta.env.VITE_NOTEBOOK_COLLAB_URL as string | undefined

async function getAccessToken() {
  return window.notebookDesktop?.secrets.get('collaboration-token') ?? undefined
}

export function useCollaborativeDocument(workspaceId: string, pageId: string) {
  // Without a collaboration server the session is fully synchronous: creating
  // it in the initializer avoids a spurious loading frame on every page open.
  const [session, setSession] = useState<CollaborativeDocumentSession | undefined>(() => (
    collaborationUrl ? undefined : { document: new Y.Doc(), status: 'offline' }
  ))

  useEffect(() => {
    if (!collaborationUrl) return
    let disposed = false
    const document = new Y.Doc()
    const documentName = `${workspaceId}:page:${pageId}`
    let provider: HocuspocusProvider | undefined
    let readOnly = true
    let synced = false
    let authenticationFailed = false

    void (async () => {
      const token = await getAccessToken()
      if (disposed) return
      provider = new HocuspocusProvider({
        url: collaborationUrl,
        name: documentName,
        document,
        token,
        onAuthenticated: ({ scope }) => {
          authenticationFailed = false
          readOnly = scope === 'readonly'
          if (!disposed) setSession({ document, provider, status: 'connected', readOnly, synced })
        },
        onStatus: ({ status }) => {
          if (!disposed) setSession({ document, provider, status: authenticationFailed ? 'error' : status === 'connected' ? 'connected' : 'connecting', readOnly, synced })
        },
        onSynced: ({ state }) => {
          synced = state
          if (!disposed) setSession({ document, provider, status: authenticationFailed ? 'error' : state ? 'connected' : 'connecting', readOnly, synced })
        },
        onAuthenticationFailed: () => {
          authenticationFailed = true
          if (!disposed) setSession({ document, provider, status: 'error', readOnly, synced })
        },
      })
      setSession({ document, provider, status: 'connecting', readOnly, synced })
    })().catch(() => {
      if (!disposed) setSession({ document, status: 'error', readOnly, synced })
    })

    return () => {
      disposed = true
      provider?.destroy()
      document.destroy()
    }
  }, [pageId, workspaceId])

  return session
}
