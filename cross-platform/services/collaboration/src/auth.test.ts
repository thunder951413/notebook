import { SignJWT } from 'jose'
import { expect, test } from 'vitest'
import { assertDocumentAccess, authenticateRequest } from './auth'

test('local development identity is scoped to the requested workspace', async () => {
  const identity = await authenticateRequest(null, undefined, true, 'workspace-under-test')
  expect(identity).toEqual({ userId: 'local-user', workspaceId: 'workspace-under-test', role: 'owner' })
  expect(assertDocumentAccess(identity, 'workspace-under-test:page:page-1')).toEqual({ workspaceId: 'workspace-under-test', kind: 'page', id: 'page-1' })
})

test('validates signed collaboration claims and workspace document names', async () => {
  const secret = 'test-secret-that-is-long-enough'
  const token = await new SignJWT({ workspaceId: 'workspace-a', role: 'editor' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-a')
    .setIssuer('notebook-api')
    .setAudience('notebook-collaboration')
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret))
  const identity = await authenticateRequest(`Bearer ${token}`, secret, false)
  expect(identity).toEqual({ userId: 'user-a', workspaceId: 'workspace-a', role: 'editor' })
  expect(assertDocumentAccess(identity, 'workspace-a:page:page-a')).toMatchObject({ kind: 'page', id: 'page-a' })
  expect(() => assertDocumentAccess(identity, 'workspace-b:page:page-a')).toThrow(/outside/)
})

test('only permits anonymous access for explicit local development', async () => {
  await expect(authenticateRequest(null, undefined, true)).resolves.toMatchObject({ role: 'owner' })
  await expect(authenticateRequest(null, undefined, false)).rejects.toThrow(/required/)
})
