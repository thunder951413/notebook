import { useCallback, useEffect, useRef, useState } from 'react'
import { base64ToBytes } from '../data/transfer'
import { entryFromFile, entryFromImage, entryFromText, readInboxShortcut, type InboxEntry } from '../ai/inbox'
import { recordDiagnosticEvent } from '../diagnostics/diagnostics'

const CLIPBOARD_KEY = 'notebook-inbox-clipboard-change-v1'
const readTaken = () => { try { return Number(localStorage.getItem(CLIPBOARD_KEY) ?? NaN) } catch { return NaN } }
const saveTaken = (value: number) => { try { localStorage.setItem(CLIPBOARD_KEY, String(value)) } catch { /* storage unavailable */ } }

/**
 * The AI inbox's intake: the global shortcut (reads the clipboard), files
 * opened with the app (Dock icon, “Open With”) and files dropped anywhere on
 * the window. `entries` is undefined while the inbox is closed.
 */
export function useInbox(htmlToMarkdown: (html: string) => string) {
  const [entries, setEntries] = useState<InboxEntry[]>()
  const convert = useRef(htmlToMarkdown)
  convert.current = htmlToMarkdown
  const append = useCallback((added: InboxEntry[]) => setEntries((current) => [...(current ?? []), ...added]), [])

  /** What is copied now. `force` also takes a clipboard already taken before. */
  const clipboardEntries = useCallback(async (force: boolean): Promise<InboxEntry[]> => {
    const snapshot = await window.notebookDesktop?.clipboard.snapshot?.()
    if (!snapshot) return []
    if (!force && snapshot.changeCount === readTaken()) return []
    saveTaken(snapshot.changeCount)
    if (snapshot.skipped.length) recordDiagnosticEvent({ level: 'warning', category: 'data', action: 'inbox-clipboard', status: 'failed', message: snapshot.skipped.join('; ').slice(0, 300) })
    if (snapshot.files.length) return snapshot.files.map((file) => entryFromFile(file.name, base64ToBytes(file.dataBase64), convert.current))
    const text = entryFromText(snapshot.text ?? '', snapshot.html ?? undefined, convert.current)
    if (text) return [text]
    if (snapshot.image) return [entryFromImage(snapshot.image.name, snapshot.image.mimeType, base64ToBytes(snapshot.image.dataBase64))]
    return []
  }, [])

  const openedFiles = useCallback(async () => {
    const files = await window.notebookDesktop?.inbox?.take().catch(() => []) ?? []
    return files.map((file) => entryFromFile(file.name, base64ToBytes(file.dataBase64), convert.current))
  }, [])

  const open = useCallback(async (source: 'shortcut' | 'menu' | 'open') => {
    const added = [...await openedFiles(), ...(source === 'open' ? [] : await clipboardEntries(false).catch(() => []))]
    setEntries((current) => [...(current ?? []), ...added])
  }, [clipboardEntries, openedFiles])

  const readClipboardNow = useCallback(async () => {
    const added = await clipboardEntries(true)
    append(added)
    return added.length
  }, [append, clipboardEntries])

  const pickFiles = useCallback(async () => {
    const files = await window.notebookDesktop?.files.pickOpen().catch(() => []) ?? []
    append(files.map((file) => entryFromFile(file.name, base64ToBytes(file.dataBase64), convert.current)))
  }, [append])

  useEffect(() => {
    const desktop = window.notebookDesktop
    const unsubscribe = desktop?.events.onInbox?.((source) => { void open(source) })
    // Bind the user's shortcut, and pick up files the app was launched with.
    const shortcut = readInboxShortcut()
    if (desktop?.inbox && shortcut) {
      void desktop.inbox.setShortcut(shortcut).catch((error: unknown) => recordDiagnosticEvent({ level: 'warning', category: 'app', action: 'inbox-shortcut', status: 'failed', message: error instanceof Error ? error.message : String(error) }))
    }
    void openedFiles().then((added) => { if (added.length) append(added) })
    return unsubscribe
  }, [append, open, openedFiles])

  // Files dropped anywhere the page itself does not handle (editor, tree) go to the inbox.
  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const over = (event: DragEvent) => { if (hasFiles(event) && !event.defaultPrevented) event.preventDefault() }
    const drop = (event: DragEvent) => {
      if (!hasFiles(event) || event.defaultPrevented) return
      event.preventDefault()
      const files = [...(event.dataTransfer?.files ?? [])]
      void Promise.all(files.map(async (file) => entryFromFile(file.name, new Uint8Array(await file.arrayBuffer()), convert.current))).then(append)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('drop', drop) }
  }, [append])

  return { entries, setEntries, readClipboardNow, pickFiles, close: () => setEntries(undefined), open: () => setEntries((current) => current ?? []) }
}
