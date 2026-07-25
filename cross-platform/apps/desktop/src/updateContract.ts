export type DesktopUpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface DesktopUpdateState {
  status: DesktopUpdateStatus
  currentVersion: string
  availableVersion?: string
  releaseName?: string
  releaseDate?: string
  releaseNotes?: string
  releaseUrl: string
  checkedAt?: string
  progressPercent?: number
  transferredBytes?: number
  totalBytes?: number
  canAutoInstall: boolean
  requiresAuthentication?: boolean
  message?: string
}
