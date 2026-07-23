import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Server } from '@hocuspocus/server'
import { SQLite } from '@hocuspocus/extension-sqlite'
import { assertDocumentAccess, authenticateRequest } from './auth'

const host = process.env.NOTEBOOK_COLLAB_HOST ?? '127.0.0.1'
const port = Number.parseInt(process.env.NOTEBOOK_COLLAB_PORT ?? '1234', 10)
const databasePath = resolve(process.env.NOTEBOOK_COLLAB_DATABASE ?? './data/collaboration.sqlite')
const jwtSecret = process.env.NOTEBOOK_JWT_SECRET
const localDevelopment = host === '127.0.0.1' || host === 'localhost'

mkdirSync(dirname(databasePath), { recursive: true })

const server = new Server({
  name: 'notebook-collaboration',
  address: host,
  port,
  debounce: 1_000,
  maxDebounce: 10_000,
  extensions: [new SQLite({ database: databasePath })],
  async onAuthenticate({ requestHeaders, documentName }) {
    const requestedWorkspaceId = documentName.split(':')[0] || 'local-workspace'
    const identity = await authenticateRequest(requestHeaders.get('authorization'), jwtSecret, localDevelopment, requestedWorkspaceId)
    assertDocumentAccess(identity, documentName)
    if (identity.role === 'viewer') return { ...identity, readOnly: true }
    return identity
  },
})

await server.listen()

const shutdown = async () => {
  await server.destroy()
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
