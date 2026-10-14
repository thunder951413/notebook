import { HocuspocusProvider } from '@hocuspocus/provider'
import { SignJWT } from 'jose'
import { afterEach, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { createCollaborationServer } from './collaborationServer'

const secret = 'isolated-collaboration-test-secret'
const documentName = 'workspace-a:page:page-a'
let server: ReturnType<typeof createCollaborationServer> | undefined
const providers: HocuspocusProvider[] = []

afterEach(async () => {
  for (const provider of providers.splice(0)) {
    provider.destroy()
    provider.document.destroy()
  }
  await server?.destroy()
  server = undefined
})

async function token(role: string, workspaceId = 'workspace-a', expires = '5m') {
  return new SignJWT({ workspaceId, role }).setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-a').setIssuer('notebook-api').setAudience('notebook-collaboration')
    .setExpirationTime(expires).sign(new TextEncoder().encode(secret))
}

async function start() {
  server = createCollaborationServer({
    host: '127.0.0.1', port: 0, databasePath: ':memory:', jwtSecret: secret, quiet: true,
    extensions: [{ async onStateless({ connection, payload }) { connection.sendStateless(payload) } }],
  })
  await server.listen()
  return `ws://127.0.0.1:${server.address.port}`
}

function connect(url: string, accessToken: string | (() => Promise<string>), name = documentName) {
  const denied = vi.fn()
  const provider = new HocuspocusProvider({
    url, name, token: accessToken, document: new Y.Doc(),
    onAuthenticationFailed: denied,
  })
  providers.push(provider)
  return { provider, denied }
}

async function barrier(provider: HocuspocusProvider) {
  const reply = vi.fn()
  provider.on('stateless', reply)
  provider.flushPendingUpdates()
  provider.sendStateless('write-barrier')
  await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ payload: 'write-barrier' }))
  provider.off('stateless', reply)
}

test.each(['owner', 'editor'])('authenticates a browser %s token and synchronizes real edits', async role => {
  const url = await start()
  const { provider } = connect(url, await token(role))
  await vi.waitFor(() => expect(provider.isSynced).toBe(true))
  expect(provider.authorizedScope).toBe('read-write')
  provider.document.getText('body').insert(0, '中文协作正文')
  await barrier(provider)
  expect(server!.hocuspocus.documents.get(documentName)?.getText('body').toString()).toBe('中文协作正文')
})

test('viewers receive remote edits but cannot change the server document', async () => {
  const url = await start()
  const editor = connect(url, await token('editor')).provider
  await vi.waitFor(() => expect(editor.isSynced).toBe(true))
  editor.document.getText('body').insert(0, 'editor baseline')
  await barrier(editor)
  const viewer = connect(url, await token('viewer')).provider
  await vi.waitFor(() => expect(viewer.isSynced).toBe(true))
  expect(viewer.authorizedScope).toBe('readonly')
  expect(viewer.document.getText('body').toString()).toBe('editor baseline')
  // HocuspocusProvider still sends this update; the server must reject it.
  viewer.document.getText('body').insert(0, 'unauthorized viewer write')
  await barrier(viewer)
  expect(server!.hocuspocus.documents.get(documentName)?.getText('body').toString()).toBe('editor baseline')
  editor.document.getText('body').insert(0, 'next edit ')
  await barrier(editor)
  expect(server!.hocuspocus.documents.get(documentName)?.getText('body').toString()).toBe('next edit editor baseline')
})

test('revalidates refreshed tokens and applies a downgrade on the existing connection', async () => {
  const url = await start()
  let accessToken = await token('editor')
  const provider = connect(url, async () => accessToken).provider
  await vi.waitFor(() => expect(provider.isSynced).toBe(true))
  provider.document.getText('body').insert(0, 'before downgrade')
  await barrier(provider)
  accessToken = await token('viewer')
  await provider.sendToken()
  await barrier(provider)
  await vi.waitFor(() => expect(provider.authorizedScope).toBe('readonly'))
  provider.document.getText('body').insert(0, 'must be rejected')
  await barrier(provider)
  expect(server!.hocuspocus.documents.get(documentName)?.getText('body').toString()).toBe('before downgrade')
})

test.each(['missing', 'invalid', 'expired', 'other-workspace', 'unknown-role', 'extra-name-part'])('rejects %s authentication before loading a document', async scenario => {
  const url = await start()
  const accessToken = scenario === 'missing' ? '' : scenario === 'invalid' ? 'invalid-token'
    : await token(scenario === 'unknown-role' ? 'admin' : 'editor', scenario === 'other-workspace' ? 'workspace-b' : 'workspace-a', scenario === 'expired' ? '-1m' : '5m')
  const { provider, denied } = connect(url, accessToken, scenario === 'extra-name-part' ? `${documentName}:` : documentName)
  await vi.waitFor(() => expect(denied).toHaveBeenCalled())
  expect(provider.isAuthenticated).toBe(false)
  expect(server!.hocuspocus.documents.size).toBe(0)
})

test('requires a secret for a public bind address', () => {
  expect(() => createCollaborationServer({ host: '0.0.0.0', port: 0, databasePath: ':memory:', extensions: [] })).toThrow(/required/)
})
