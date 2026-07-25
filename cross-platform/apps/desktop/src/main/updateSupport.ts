import { clean, coerce, gt } from 'semver'

export const GITHUB_RELEASE_URL = 'https://github.com/thunder951413/notebook/releases'
export const GITHUB_RELEASES_API = 'https://api.github.com/repos/thunder951413/notebook/releases?per_page=30'

export interface GitHubLatestRelease {
  tag_name: string
  name?: string | null
  body?: string | null
  html_url: string
  published_at?: string | null
  draft?: boolean
  prerelease?: boolean
  assets?: Array<{ name: string }>
}

export function updateMetadataName(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'latest-mac.yml'
  if (platform === 'linux') return 'latest-linux.yml'
  return 'latest.yml'
}

export function findLatestElectronRelease(releases: GitHubLatestRelease[], platform: NodeJS.Platform): GitHubLatestRelease | undefined {
  const metadataName = updateMetadataName(platform)
  return releases.find((release) =>
    !release.draft
    && !release.prerelease
    && release.assets?.some((asset) => asset.name === metadataName),
  )
}

export function normalizeReleaseVersion(value: string): string | undefined {
  const trimmed = value.trim().replace(/^release[-_/ ]*/i, '').replace(/^v/i, '')
  return clean(trimmed) ?? coerce(trimmed)?.version
}

export function isNewerRelease(currentVersion: string, releaseTag: string): boolean {
  const current = normalizeReleaseVersion(currentVersion)
  const release = normalizeReleaseVersion(releaseTag)
  return Boolean(current && release && gt(release, current))
}

export function readableUpdateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '未知错误')
  if (/404|not found/i.test(raw)) return 'GitHub 上还没有公开发布的 Release。'
  if (/ENOTFOUND|ERR_INTERNET_DISCONNECTED|network|fetch failed/i.test(raw)) return '无法连接 GitHub，请检查网络、代理或防火墙设置。'
  if (/signature|code sign|not signed/i.test(raw)) return '更新包签名校验失败，已阻止安装。'
  if (/checksum|sha512|integrity/i.test(raw)) return '更新包完整性校验失败，已阻止安装。'
  return `检查更新失败：${raw}`
}
