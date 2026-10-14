import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createCollaborationServer } from './collaborationServer'

const host = process.env.NOTEBOOK_COLLAB_HOST ?? '127.0.0.1'
const port = Number.parseInt(process.env.NOTEBOOK_COLLAB_PORT ?? '1234', 10)
const databasePath = resolve(process.env.NOTEBOOK_COLLAB_DATABASE ?? './data/collaboration.sqlite')
const jwtSecret = process.env.NOTEBOOK_JWT_SECRET

mkdirSync(dirname(databasePath), { recursive: true })

const server = createCollaborationServer({ host, port, databasePath, jwtSecret })

await server.listen()

const shutdown = async () => {
  await server.destroy()
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
