type DesktopInputSourceApi = Pick<NonNullable<Window['notebookDesktop']>, 'platform' | 'inputSource'>

export function useAbcInputSourceForVimNormal(
  vimEnabled: boolean,
  vimCommandMode: boolean,
  desktop = window.notebookDesktop as DesktopInputSourceApi | undefined,
) {
  if (!vimEnabled || !vimCommandMode || desktop?.platform !== 'darwin') return false
  void desktop.inputSource.useAbc().catch(() => false)
  return true
}
