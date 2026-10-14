/** Public types of the legacy SSH/SFTP repository transport (Electron only, deprecated). */
export interface LegacySshConnection {
  host: string
  port: number
  username: string
  remotePath: string
  fingerprint?: string
  /** SSH 登录密码（与 privateKeyPath 二选一；服务器仅允许公钥认证时留空）。 */
  password?: string
  /** SSH 私钥文件路径（如 ~/.ssh/id_ed25519）。提供时优先使用公钥认证。 */
  privateKeyPath?: string
  /** SSH 私钥口令（加密私钥时必填，无口令私钥留空）。 */
  privateKeyPassphrase?: string
}

export interface LegacySftpFile { name: string; data: Uint8Array }
export interface LegacySftpPullOptions {
  knownObjectHashes?: string[]
  knownNoteSignatures?: Array<{ noteID: string; signature: string }>
  /** Skip note bodies and objects; only repository metadata is returned. */
  metadataOnly?: boolean
  /** Reuse the SSH connection opened by a previous pull/push. */
  sessionId?: string
}
export interface LegacySftpPushOptions {
  knownObjectHashes?: string[]
  sessionId?: string
}
export interface LegacySftpPullResult {
  files: LegacySftpFile[]
  indexHash: string
  fingerprint: string
  objectHashes: string[]
  reusedObjectCount: number
  reusedNoteIds: string[]
  sessionId: string
}

export interface LegacySftpConnectionResult {
  fingerprint: string
  remotePath: string
  remotePathExists: boolean
  latencyMs: number
}

export interface LegacySftpHelperResult {
  ok: boolean
  /** Binary payload for export-tar; undefined for the other operations. */
  data?: Uint8Array
  /** Human-readable result, e.g. verify errors or gc removed count. */
  message: string
}

