import { useEffect, useState } from 'react'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'

export type CollaborationStatus = 'loading' | 'offline' | 'connecting' | 'connected' | 'error'

export interface CollaborativeDocumentSession {
  document: Y.Doc
  provider?: HocuspocusProvider
  status: CollaborationStatus
}

const collaborationUrl = import.meta.env.VITE_NOTEBOOK_COLLAB_URL as string | undefined

async function getAccessToken() {
  return window.notebookDesktop?.secrets.get('collaboration-token') ?? undefined
}

export function useCollaborativeDocument(workspaceId: string, pageId: string) {
  const [session, setSession] = useState<CollaborativeDocumentSession>()

  useEffect(() => {
    let disposed = false
    const document = new Y.Doc()
    const documentName = `${workspaceId}:page:${pageId}`
    let provider: HocuspocusProvider | undefined

    if (!collaborationUrl) setSession({ document, status: 'offline' })
    else void (async () => {
      const token = await getAccessToken()
      if (disposed) return
      provider = new HocuspocusProvider({
        url: collaborationUrl,
        name: documentName,
        document,
        token,
        onStatus: ({ status }) => {
          if (!disposed) setSession({ document, provider, status: status === 'connected' ? 'connected' : 'connecting' })
        },
        onAuthenticationFailed: () => {
          if (!disposed) setSession({ document, provider, status: 'error' })
        },
      })
      setSession({ document, provider, status: 'connecting' })
    })().catch(() => {
      if (!disposed) setSession({ document, status: 'error' })
    })

    return () => {
      disposed = true
      provider?.destroy()
      document.destroy()
    }
  }, [pageId, workspaceId])

  return session
}
