import type { KeyboardEvent } from 'react'

/**
 * Escape closes a dialog, as it does in settings, the confirm dialog and the
 * command palette. Put it on the dialog element: only a dialog that holds the
 * focus reacts, so a confirm dialog on top closes alone.
 */
export const closeOnEscape = (onClose: () => void) => (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
  event.stopPropagation()
  onClose()
}
