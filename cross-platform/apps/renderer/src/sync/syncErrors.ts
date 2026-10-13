/**
 * Turn transport/library errors into a sentence that says what happened and
 * what to do. The original message is kept (in brackets) for diagnostics.
 */
export function describeSyncError(message: string): string {
  const rules: Array<[RegExp, string]> = [
    [/\b401\b|unauthori[sz]ed|认证失败|authentication/i, '坚果云拒绝登录：用户名或应用密码不正确。应用密码需要在坚果云网页版“账户信息 → 安全选项”中重新生成。'],
    [/\b429\b|\b503\b|too many requests|rate limit|service unavailable/i, '坚果云暂时限流（请求过于频繁）。稍后会自动重试，无需操作。'],
    [/\b403\b|forbidden/i, '坚果云拒绝访问同步目录（403）。请检查远端目录名称是否正确；若刚频繁同步，也可能是暂时限流，稍后会自动重试。'],
    [/\b507\b|insufficient storage|空间不足/i, '坚果云空间已满，无法上传。请清理空间后重试。'],
    [/\b404\b.*(dav|webdav)|not found/i, '找不到坚果云服务器上的同步目录。请确认服务器地址与远端目录。'],
    [/enotfound|eai_again|econnrefused|econnreset|enetunreach|etimedout|network|fetch failed|socket hang up|无法连接|offline/i, '网络连接失败。联网后会自动重试，本机修改已安全保存。'],
    [/超时/, '网络较慢，本次同步超时。本机修改已安全保存，稍后会自动重试。'],
    [/密钥|decrypt|unable to authenticate data|authentication tag/i, '隐私同步密钥与其他设备不一致，私密内容无法解密。请在所有设备上设置相同的隐私同步密钥；在此之前不会覆盖本机内容。'],
    [/缺少本地内容|无法恢复/, '有附件在本机缺失，相关变更暂缓上传。其他内容已正常同步。'],
  ]
  for (const [pattern, friendly] of rules) {
    if (pattern.test(message)) return friendly === message ? message : `${friendly}（${message}）`
  }
  return message
}

const LAST_SUCCESS_KEY = 'notebook-sync-last-success-v1'

export function recordSyncSuccess(at = new Date()) {
  try { window.localStorage?.setItem(LAST_SUCCESS_KEY, at.toISOString()) } catch { /* storage unavailable */ }
}

export function lastSyncSuccess(): Date | undefined {
  try {
    const value = window.localStorage?.getItem(LAST_SUCCESS_KEY)
    const date = value ? new Date(value) : undefined
    return date && !Number.isNaN(date.getTime()) ? date : undefined
  } catch { return undefined }
}

export function relativeTime(date: Date | undefined, now = Date.now()): string {
  if (!date) return '尚未成功同步'
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天前`
  return date.toLocaleDateString()
}
