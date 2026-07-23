import { useEffect, useRef } from 'react'
import { EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { documentToMarkdown, markdownToDocument } from './extensions'
import { registerFlushHandler } from '../data/flushCoordinator'

export interface MarkdownSourceEditorProps {
  workspaceId: string
  pageId: string
  content: Record<string, unknown>
  onChange: (document: Record<string, unknown>) => void | Promise<void>
  onDraft?: (document: Record<string, unknown>) => void | Promise<void>
}

function minimalChange(current: string, next: string) {
  let from = 0
  const limit = Math.min(current.length, next.length)
  while (from < limit && current.charCodeAt(from) === next.charCodeAt(from)) from += 1
  let currentEnd = current.length
  let nextEnd = next.length
  while (currentEnd > from && nextEnd > from && current.charCodeAt(currentEnd - 1) === next.charCodeAt(nextEnd - 1)) {
    currentEnd -= 1
    nextEnd -= 1
  }
  return { from, to: currentEnd, insert: next.slice(from, nextEnd) }
}

export default function MarkdownSourceEditor({ pageId, content, onChange, onDraft }: MarkdownSourceEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | undefined>(undefined)
  const onChangeRef = useRef(onChange)
  const onDraftRef = useRef(onDraft)
  const dirty = useRef(false)
  const applyingExternal = useRef(false)
  const pendingExternal = useRef<string | undefined>(undefined)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  onChangeRef.current = onChange
  onDraftRef.current = onDraft

  const commit = async () => {
    const view = viewRef.current
    if (!view) return
    clearTimeout(saveTimer.current)
    clearTimeout(draftTimer.current)
    const markdownText = view.state.doc.toString()
    const json = markdownToDocument(markdownText)
    await onDraftRef.current?.(json)
    await onChangeRef.current(json)
    if (view.state.doc.toString() === markdownText) dirty.current = false
    if (!dirty.current) pendingExternal.current = undefined
  }

  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: documentToMarkdown(content),
        extensions: [
          lineNumbers(), history(), markdown(), EditorView.lineWrapping,
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || applyingExternal.current) return
            dirty.current = true
            clearTimeout(draftTimer.current)
            draftTimer.current = setTimeout(() => {
              const json = markdownToDocument(update.state.doc.toString())
              void Promise.resolve(onDraftRef.current?.(json)).catch(() => undefined)
            }, 50)
            clearTimeout(saveTimer.current)
            saveTimer.current = setTimeout(() => { void commit() }, 450)
          }),
          EditorView.domEventHandlers({
            blur: () => {
              if (dirty.current) void commit()
              else if (pendingExternal.current !== undefined) {
                const next = pendingExternal.current
                pendingExternal.current = undefined
                const current = view.state.doc.toString()
                if (current !== next) {
                  applyingExternal.current = true
                  view.dispatch({ changes: minimalChange(current, next), annotations: Transaction.addToHistory.of(false) })
                  applyingExternal.current = false
                }
              }
            },
          }),
          EditorView.theme({
            '&': { height: '100%', backgroundColor: 'transparent' },
            '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
            '.cm-content': { maxWidth: '880px', margin: '0 auto', padding: '28px 32px 45vh' },
            '.cm-gutters': { backgroundColor: 'transparent', border: '0' },
          }),
        ],
      }),
    })
    viewRef.current = view
    const unregisterFlush = registerFlushHandler(commit)
    return () => {
      unregisterFlush()
      clearTimeout(saveTimer.current)
      clearTimeout(draftTimer.current)
      viewRef.current = undefined
      view.destroy()
    }
    // A page switch remounts the editor. Content changes are handled below
    // without rebuilding CodeMirror or discarding its undo history.
  }, [pageId])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const next = documentToMarkdown(content)
    const current = view.state.doc.toString()
    if (next === current) return
    if (view.hasFocus || dirty.current) {
      pendingExternal.current = next
      return
    }
    applyingExternal.current = true
    view.dispatch({ changes: minimalChange(current, next), annotations: Transaction.addToHistory.of(false) })
    applyingExternal.current = false
  }, [content])

  return <div ref={host} className="source-editor" aria-label="Markdown 源码编辑器" />
}
