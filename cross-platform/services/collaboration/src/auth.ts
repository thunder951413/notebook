import { jwtVerify } from 'jose'

export interface CollaborationIdentity {
  userId: string
  workspaceId: string
  role: 'owner' | 'editor' | 'viewer'
}

const bearerToken = (header: string | null) => {
  if (!header?.startsWith('Bearer ')) return undefined
  return header.slice('Bearer '.length).trim() || undefined
}

export async function authenticateRequest(
  authorization: string | null,
  secret: string | undefined,
  allowInsecureDevelopment: boolean,
  developmentWorkspaceId = 'local-workspace',
): Promise<CollaborationIdentity> {
  const token = bearerToken(authorization)
  if (!secret) {
    if (!allowInsecureDevelopment) throw new Error('NOTEBOOK_JWT_SECRET is required outside local development')
    return { userId: 'local-user', workspaceId: developmentWorkspaceId, role: 'owner' }
  }
  if (!token) throw new Error('Missing bearer token')
  const verified = await jwtVerify(token, new TextEncoder().encode(secret), {
    audience: 'notebook-collaboration',
    issuer: 'notebook-api',
  })
  const workspaceId = verified.payload.workspaceId
  const role = verified.payload.role
  if (typeof verified.payload.sub !== 'string' || typeof workspaceId !== 'string' || !['owner', 'editor', 'viewer'].includes(String(role))) {
    throw new Error('Token is missing collaboration claims')
  }
  return { userId: verified.payload.sub, workspaceId, role: role as CollaborationIdentity['role'] }
}

export function assertDocumentAccess(identity: CollaborationIdentity, documentName: string) {
  const parts = documentName.split(':')
  const [workspaceId, kind, id] = parts
  if (parts.length !== 3 || workspaceId !== identity.workspaceId || kind !== 'page' || !id) {
    throw new Error('Document is outside the authenticated workspace')
  }
  return { workspaceId, kind: 'page' as const, id }
}
