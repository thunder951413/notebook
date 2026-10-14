import { OutgoingMessage, Server, type ServerConfiguration } from '@hocuspocus/server'
import { SQLite } from '@hocuspocus/extension-sqlite'
import { assertDocumentAccess, authenticateRequest, type CollaborationIdentity } from './auth'

interface CollaborationServerOptions {
  host: string
  port: number
  databasePath: string
  jwtSecret?: string
  extensions?: ServerConfiguration<CollaborationIdentity>['extensions']
  quiet?: boolean
}

export function createCollaborationServer(options: CollaborationServerOptions) {
  const localDevelopment = options.host === '127.0.0.1' || options.host === 'localhost' || options.host === '::1'
  if (!options.jwtSecret && !localDevelopment) throw new Error('NOTEBOOK_JWT_SECRET is required outside local development')

  const authenticate = async (token: string, headers: Headers, documentName: string) => {
    const requestedWorkspaceId = documentName.split(':')[0] || 'local-workspace'
    // Browser providers authenticate inside the WebSocket protocol. Retain
    // HTTP bearer headers for native clients, without overriding a sent token.
    const identity = await authenticateRequest(token ? `Bearer ${token}` : headers.get('authorization'), options.jwtSecret, localDevelopment, requestedWorkspaceId)
    assertDocumentAccess(identity, documentName)
    return identity
  }

  return new Server<CollaborationIdentity>({
    name: 'notebook-collaboration',
    address: options.host,
    port: options.port,
    debounce: 1_000,
    maxDebounce: 10_000,
    stopOnSignals: false,
    quiet: options.quiet,
    extensions: options.extensions ?? [new SQLite({ database: options.databasePath })],
    async onAuthenticate({ token, requestHeaders, documentName, connectionConfig }) {
      const identity = await authenticate(token, requestHeaders, documentName)
      connectionConfig.readOnly = identity.role === 'viewer'
      return identity
    },
    async onTokenSync({ token, requestHeaders, documentName, connectionConfig, connection }) {
      const identity = await authenticate(token, requestHeaders, documentName)
      connectionConfig.readOnly = identity.role === 'viewer'
      connection.readOnly = connectionConfig.readOnly
      connection.context = identity
      connection.send(new OutgoingMessage(connection.messageAddress).writeAuthenticated(connection.readOnly).toUint8Array())
      return identity
    },
  })
}
