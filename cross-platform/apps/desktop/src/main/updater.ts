import { app, BrowserWindow, net, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import electronUpdater, { type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { DesktopUpdateState } from '../updateContract'
import {
  GITHUB_RELEASES_API,
  GITHUB_RELEASE_URL,
  findLatestElectronRelease,
  isNewerRelease,
  normalizeReleaseVersion,
  readableUpdateError,
  type GitHubLatestRelease,
} from './updateSupport'

const { autoUpdater } = electronUpdater
const AUTOMATIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000
const INITIAL_CHECK_DELAY_MS = 12_000

function releaseNotesText(notes: UpdateInfo['releaseNotes']): string | undefined {
  if (typeof notes === 'string') return notes
  if (!Array.isArray(notes)) return undefined
  return notes.map((note) => `${note.version ? `## ${note.version}\n` : ''}${note.note ?? ''}`.trim()).filter(Boolean).join('\n\n')
}

export class DesktopUpdateService {
  private state: DesktopUpdateState
  private checking = false
  private configured = false
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly getAccessToken: () => Promise<string | undefined>,
    private readonly beforeInstall: () => Promise<void>,
  ) {
    this.state = {
      status: 'idle',
      currentVersion: app.getVersion(),
      releaseUrl: GITHUB_RELEASE_URL,
      canAutoInstall: this.hasNativeUpdater(),
      message: this.hasNativeUpdater()
        ? '可从 GitHub Release 检查并安装新版本。'
        : '可以检查 GitHub Release；当前运行方式需要从发布页手动下载安装包。',
    }
  }

  private hasNativeUpdater() {
    const portableWindowsBuild = process.platform === 'win32' && Boolean(process.env.PORTABLE_EXECUTABLE_FILE)
    return app.isPackaged
      && !portableWindowsBuild
      && existsSync(join(process.resourcesPath, 'app-update.yml'))
  }

  private publish(patch: Partial<DesktopUpdateState>) {
    this.state = { ...this.state, ...patch, canAutoInstall: this.hasNativeUpdater() }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('notebook:update-state', this.state)
    }
  }

  getState() {
    return { ...this.state }
  }

  configure() {
    if (this.configured) return
    this.configured = true
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowDowngrade = false
    autoUpdater.allowPrerelease = false

    autoUpdater.on('checking-for-update', () => this.publish({
      status: 'checking',
      message: '正在检查 GitHub Release…',
    }))
    autoUpdater.on('update-available', (info) => this.publishAvailable(info))
    autoUpdater.on('update-not-available', (info) => this.publish({
      status: 'up-to-date',
      availableVersion: undefined,
      releaseName: undefined,
      releaseDate: undefined,
      releaseNotes: undefined,
      checkedAt: new Date().toISOString(),
      message: `当前已是最新版本（${info.version || app.getVersion()}）。`,
    }))
    autoUpdater.on('download-progress', (progress) => this.publishProgress(progress))
    autoUpdater.on('update-downloaded', (info) => this.publish({
      status: 'downloaded',
      availableVersion: info.version,
      releaseName: info.releaseName ?? undefined,
      releaseDate: info.releaseDate,
      releaseNotes: releaseNotesText(info.releaseNotes),
      progressPercent: 100,
      message: '更新已下载并完成校验，可以重启安装。',
    }))
    autoUpdater.on('error', (error) => {
      if (!this.checking && this.state.status !== 'downloading') return
      this.publish({ status: 'error', checkedAt: new Date().toISOString(), message: readableUpdateError(error) })
    })

    this.timer = setTimeout(() => {
      void this.check(false)
      this.timer = setInterval(() => void this.check(false), AUTOMATIC_CHECK_INTERVAL_MS)
    }, INITIAL_CHECK_DELAY_MS)
    this.timer.unref()
  }

  private publishAvailable(info: UpdateInfo) {
    this.publish({
      status: 'available',
      availableVersion: info.version,
      releaseName: info.releaseName ?? undefined,
      releaseDate: info.releaseDate,
      releaseNotes: releaseNotesText(info.releaseNotes),
      checkedAt: new Date().toISOString(),
      progressPercent: undefined,
      transferredBytes: undefined,
      totalBytes: undefined,
      message: `发现新版本 ${info.version}。`,
    })
  }

  private publishProgress(progress: ProgressInfo) {
    this.publish({
      status: 'downloading',
      progressPercent: Math.max(0, Math.min(100, progress.percent)),
      transferredBytes: progress.transferred,
      totalBytes: progress.total,
      message: `正在下载更新 ${Math.round(progress.percent)}%`,
    })
  }

  private async checkGitHubRelease() {
    const accessToken = await this.getAccessToken().catch(() => undefined)
    const response = await net.fetch(GITHUB_RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Notebook-Next/${app.getVersion()}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
    })
    if (response.status === 404) {
      this.publish({
        status: 'error',
        checkedAt: new Date().toISOString(),
        requiresAuthentication: true,
        message: accessToken
          ? 'GitHub Token 无法读取此私有仓库的 Release，请检查仓库权限。'
          : '此 GitHub 仓库为私有仓库，需要配置只读 Release Token。',
      })
      return
    }
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`)
    const releases = await response.json() as GitHubLatestRelease[]
    const release = findLatestElectronRelease(releases, process.platform)
    if (!release) {
      this.publish({
        status: 'up-to-date',
        checkedAt: new Date().toISOString(),
        requiresAuthentication: false,
        message: 'GitHub 上还没有适用于当前平台的 Electron Release。',
      })
      return
    }
    const version = normalizeReleaseVersion(release.tag_name)
    if (!version) throw new Error(`无法识别 Release 版本号：${release.tag_name}`)
    if (!isNewerRelease(app.getVersion(), release.tag_name)) {
      this.publish({
        status: 'up-to-date',
        checkedAt: new Date().toISOString(),
        requiresAuthentication: false,
        releaseUrl: release.html_url || GITHUB_RELEASE_URL,
        message: `当前已是最新版本（${app.getVersion()}）。`,
      })
      return
    }
    this.publish({
      status: 'available',
      availableVersion: version,
      releaseName: release.name || release.tag_name,
      releaseDate: release.published_at ?? undefined,
      releaseNotes: release.body ?? undefined,
      releaseUrl: release.html_url || GITHUB_RELEASE_URL,
      checkedAt: new Date().toISOString(),
      requiresAuthentication: false,
      message: this.hasNativeUpdater()
        ? `发现新版本 ${version}。`
        : `发现新版本 ${version}，请从 GitHub Release 下载安装。`,
    })
  }

  async check(manual = true) {
    if (this.checking || this.state.status === 'downloading') return this.getState()
    this.checking = true
    this.publish({ status: 'checking', message: manual ? '正在检查 GitHub Release…' : '正在后台检查更新…' })
    try {
      await this.checkGitHubRelease()
    } catch (error) {
      this.publish({ status: 'error', checkedAt: new Date().toISOString(), message: readableUpdateError(error) })
    } finally {
      this.checking = false
    }
    return this.getState()
  }

  async download() {
    if (!this.hasNativeUpdater()) {
      await shell.openExternal(this.state.releaseUrl)
      return this.getState()
    }
    if (this.state.status !== 'available') await this.check(true)
    if (this.state.status !== 'available') return this.getState()
    this.publish({ status: 'downloading', progressPercent: 0, message: '正在准备下载更新…' })
    try {
      const accessToken = await this.getAccessToken().catch(() => undefined)
      if (!accessToken) throw new Error('私有 GitHub 仓库需要只读 Release Token')
      autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'thunder951413',
        repo: 'notebook',
        private: true,
        token: accessToken,
      })
      autoUpdater.requestHeaders = { Authorization: `Bearer ${accessToken}` }
      await autoUpdater.checkForUpdates()
      await autoUpdater.downloadUpdate()
    } catch (error) {
      this.publish({ status: 'error', message: readableUpdateError(error) })
    }
    return this.getState()
  }

  async install() {
    if (this.state.status !== 'downloaded') return false
    await this.beforeInstall()
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
    return true
  }

  async openReleasePage() {
    await shell.openExternal(this.state.releaseUrl)
  }
}
