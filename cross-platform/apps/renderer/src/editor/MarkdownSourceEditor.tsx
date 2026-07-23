import { useEffect, useRef, useState } from 'react'
import { EditorState, Transaction } from '@codemirror/state'
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { getCM, vim } from '@replit/codemirror-vim'
import { Button } from '@fluentui/react-components'
import {
  CheckboxChecked20Regular,
  Code20Regular,
  Image20Regular,
  MathFormula20Regular,
  Table20Regular,
  TextBold20Regular,
  TextHeader220Regular,
  TextItalic20Regular,
} from '@fluentui/react-icons'
import type { Asset } from '@notebook/domain'
import { documentToMarkdown, markdownToDocument } from './extensions'
import { registerFlushHandler } from '../data/flushCoordinator'

export interface MarkdownSourceEditorProps {
  workspaceId: string
  pageId: string
  content: Record<string, unknown>
  onChange: (document: Record<string, unknown>) => void | Promise<void>
  onDraft?: (document: Record<string, unknown>) => void | Promise<void>
  saveImage?: (file: File) => Promise<Asset>
  vimEnabled?: boolean
  onVimCommandModeChange?: (active: boolean) => void
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

export default function MarkdownSourceEditor({ pageId, content, onChange, onDraft, saveImage, vimEnabled = false, onVimCommandModeChange }: MarkdownSourceEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const viewRef = useRef<EditorView | undefined>(undefined)
  const onChangeRef = useRef(onChange)
  const onDraftRef = useRef(onDraft)
  const onVimCommandModeChangeRef = useRef(onVimCommandModeChange)
  const dirty = useRef(false)
  const applyingExternal = useRef(false)
  const pendingExternal = useRef<string | undefined>(undefined)
  const [ready, setReady] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  onChangeRef.current = onChange
  onDraftRef.current = onDraft
  onVimCommandModeChangeRef.current = onVimCommandModeChange

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
          ...(vimEnabled ? [vim({ status: true }), drawSelection()] : []),
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
    setReady(true)
    const cm = vimEnabled ? getCM(view) : null
    const handleVimModeChange = (event: { mode?: string }) => onVimCommandModeChangeRef.current?.(event.mode !== 'insert' && event.mode !== 'replace')
    if (cm) {
      cm.on('vim-mode-change', handleVimModeChange)
      onVimCommandModeChangeRef.current?.(true)
    } else {
      onVimCommandModeChangeRef.current?.(false)
    }
    const unregisterFlush = registerFlushHandler(commit)
    return () => {
      unregisterFlush()
      cm?.off('vim-mode-change', handleVimModeChange)
      onVimCommandModeChangeRef.current?.(false)
      clearTimeout(saveTimer.current)
      clearTimeout(draftTimer.current)
      viewRef.current = undefined
      view.destroy()
    }
    // A page switch remounts the editor. Content changes are handled below
    // without rebuilding CodeMirror or discarding its undo history.
  }, [pageId, vimEnabled])

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

  const replaceSelection = (before: string, after = before, placeholder = '') => {
    const view = viewRef.current
    if (!view) return
    const { from, to } = view.state.selection.main
    const selected = view.state.sliceDoc(from, to) || placeholder
    const insert = `${before}${selected}${after}`
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + before.length, head: from + before.length + selected.length } })
    view.focus()
  }

  const prefixLines = (prefix: string) => {
    const view = viewRef.current
    if (!view) return
    const selection = view.state.selection.main
    const first = view.state.doc.lineAt(selection.from)
    const last = view.state.doc.lineAt(selection.to)
    const changes: Array<{ from: number; insert: string }> = []
    for (let lineNumber = first.number; lineNumber <= last.number; lineNumber += 1) changes.push({ from: view.state.doc.line(lineNumber).from, insert: prefix })
    view.dispatch({ changes })
    view.focus()
  }

  const insertBlock = (markdownText: string) => {
    const view = viewRef.current
    if (!view) return
    const { from, to } = view.state.selection.main
    view.dispatch({ changes: { from, to, insert: markdownText }, selection: { anchor: from + markdownText.length } })
    view.focus()
  }

  const insertImage = async (file?: File) => {
    if (!file || !saveImage) return
    try {
      const asset = await saveImage(file)
      insertBlock(`![${file.name}](notebook-asset:${asset.id})`)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '图片插入失败')
    } finally {
      if (imageInput.current) imageInput.current.value = ''
    }
  }

  return <div className="source-editor-shell">
    {ready && <div className="format-toolbar source-format-toolbar" role="toolbar" aria-label="Markdown 源码格式">
      <div className="format-group" aria-label="文本样式">
        <Button size="small" appearance="subtle" icon={<TextBold20Regular />} title="用 Markdown 标记粗体" onClick={() => replaceSelection('**', '**', '粗体文字')}>粗体</Button>
        <Button size="small" appearance="subtle" icon={<TextItalic20Regular />} title="用 Markdown 标记斜体" onClick={() => replaceSelection('*', '*', '斜体文字')}>斜体</Button>
        <Button size="small" appearance="subtle" icon={<TextHeader220Regular />} title="插入二级标题标记" onClick={() => prefixLines('## ')}>标题</Button>
      </div>
      <div className="format-group" aria-label="插入 Markdown 内容">
        {saveImage && <><input ref={imageInput} hidden type="file" accept="image/*" onChange={(event) => { void insertImage(event.target.files?.[0]) }} /><Button size="small" appearance="subtle" icon={<Image20Regular />} title="插入图片引用" onClick={() => imageInput.current?.click()}>图片</Button></>}
        <Button size="small" appearance="subtle" icon={<CheckboxChecked20Regular />} title="插入待办列表标记" onClick={() => prefixLines('- [ ] ')}>待办</Button>
        <Button size="small" appearance="subtle" icon={<Table20Regular />} title="插入 Markdown 表格" onClick={() => insertBlock('| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |')}>表格</Button>
        <Button size="small" appearance="subtle" icon={<MathFormula20Regular />} title="插入块公式" onClick={() => insertBlock('$$\nE = mc^2\n$$')}>公式</Button>
        <Button size="small" appearance="subtle" icon={<Code20Regular />} title="插入代码块" onClick={() => replaceSelection('```\n', '\n```', '代码')}>代码</Button>
      </div>
    </div>}
    <div ref={host} className="source-editor" aria-label="Markdown 源码编辑器" />
  </div>
}
