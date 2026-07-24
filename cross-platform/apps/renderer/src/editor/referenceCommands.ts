import type { NotebookReferenceTarget } from '@notebook/sync-contract'

export interface InsertReferenceDetail {
  target: NotebookReferenceTarget
  embed: boolean
  alias?: string
}

export const INSERT_REFERENCE_EVENT = 'notebook:insert-reference'
export const OPEN_REFERENCE_PICKER_EVENT = 'notebook:open-reference-picker'

export function insertNotebookReference(detail: InsertReferenceDetail) {
  window.dispatchEvent(new CustomEvent<InsertReferenceDetail>(INSERT_REFERENCE_EVENT, { detail }))
}

export function openReferencePicker() {
  window.dispatchEvent(new Event(OPEN_REFERENCE_PICKER_EVENT))
}
