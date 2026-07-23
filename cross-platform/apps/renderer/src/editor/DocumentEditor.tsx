import { useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import Placeholder from '@tiptap/extension-placeholder'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import type { Editor } from '@tiptap/core'
import { Selection, TextSelection, type EditorState } from 'prosemirror-state'
import { useCollaborativeDocument } from '../collaboration/useCollaborativeDocument'
import { createContentExtensions, sanitizeSupportedHtml, type AssetLoader } from './extensions'
import { registerFlushHandler } from '../data/flushCoordinator'

export const initialContent = `
  <h1>Notebook Next 产品愿景</h1>
  <p class="lead">把笔记、任务、AI 与跨设备编辑放进同一个可靠的工作区。</p>
  <h2>我们想解决什么</h2>
  <p>新版本让每一篇页面都能自然记录、快速检索，并在不同设备之间保持一致。</p>
  <blockquote><p>像 OneNote 一样自然地记录，再让 AI 基于当前笔记和可追溯来源继续工作。</p></blockquote>
  <h2>首要原则</h2>
  <ul>
    <li><p><strong>离线优先：</strong>没有网络时仍可完整编辑，重新连接后自动合并。</p></li>
    <li><p><strong>数据可信：</strong>自动保存、版本历史、迁移快照和附件校验必须默认开启。</p></li>
    <li><p><strong>AI 可审计：</strong>回答标明引用来源，写回笔记前由用户确认。</p></li>
    <li><p><strong>开放格式：</strong>支持 Markdown、HTML、PDF 和版本化 JSON 导入导出。</p></li>
  </ul>
  <h2>下一步</h2>
  <p>继续完善跨平台数据层、编辑器、图片附件和可靠同步。</p>
`

export interface DocumentEditorProps {
  workspaceId: string
  pageId: string
  pageTitle: string
  content?: Record<string, unknown> | string
  onChange?: (json: Record<string, unknown>) => void | Promise<void>
  onDraft?: (json: Record<string, unknown>) => void | Promise<void>
  forceRestore?: boolean
  loadAsset?: AssetLoader
  vimEnabled?: boolean
}

const statusLabels = { loading: '正在载入离线副本', offline: '离线可编辑', connecting: '正在连接协作', connected: '实时协作已连接', error: '协作服务不可用 · 已离线保存' }

export function DocumentEditor({ workspaceId, pageId, pageTitle, content = initialContent, onChange, onDraft, forceRestore, loadAsset, vimEnabled = false }: DocumentEditorProps) {
  const session = useCollaborativeDocument(workspaceId, pageId)
  if (!session || session.status === 'loading') return <div className="editor-loading">正在载入离线副本…</div>
  return <ReadyDocumentEditor session={session} pageTitle={pageTitle} content={content} onChange={onChange} onDraft={onDraft} forceRestore={forceRestore} loadAsset={loadAsset} vimEnabled={vimEnabled} />
}

function ReadyDocumentEditor({ session, pageTitle, content, onChange, onDraft, forceRestore, loadAsset, vimEnabled = false }: Pick<DocumentEditorProps, 'pageTitle' | 'content' | 'onChange' | 'onDraft' | 'forceRestore' | 'loadAsset' | 'vimEnabled'> & { session: NonNullable<ReturnType<typeof useCollaborativeDocument>> }) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const latestJson = useRef<Record<string, unknown> | undefined>(undefined)
  const onChangeRef = useRef(onChange)
  const onDraftRef = useRef(onDraft)
  const vimEnabledRef = useRef(vimEnabled)
  const vimModeRef = useRef<'normal' | 'insert'>('insert')
  const pendingVimKey = useRef<string | undefined>(undefined)
  const [vimMode, setVimMode] = useState<'normal' | 'insert'>('insert')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  onChangeRef.current = onChange
  onDraftRef.current = onDraft
  vimEnabledRef.current = vimEnabled
  const changeVimMode = (mode: 'normal' | 'insert') => {
    vimModeRef.current = mode
    pendingVimKey.current = undefined
    setVimMode(mode)
  }
  const collaborative = Boolean(session.provider)
  const editor = useEditor({
    extensions: [
      ...createContentExtensions(collaborative, loadAsset),
      Placeholder.configure({ placeholder: '开始记录，或输入 / 插入内容…' }),
      ...(collaborative ? [Collaboration.configure({ document: session.document })] : []),
      ...(session.provider ? [CollaborationCaret.configure({
        provider: session.provider,
        user: { name: '本机用户', color: '#7c3aed' },
      })] : []),
    ],
    content: collaborative ? undefined : content,
    onCreate: ({ editor: currentEditor }) => {
      // Hydration is not a user edit. Emitting an update here would mark every
      // opened page as pending and could make an old local copy beat a newer
      // Android/SSH revision during the next merge.
      if (collaborative && (forceRestore || session.document.getXmlFragment('default').length === 0) && content) currentEditor.commands.setContent(content, { emitUpdate: false })
    },
    onUpdate: ({ editor: currentEditor }) => {
      latestJson.current = currentEditor.getJSON()
      void Promise.resolve(onDraftRef.current?.(latestJson.current)).catch(() => undefined)
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        if (latestJson.current) onChangeRef.current?.(latestJson.current)
      }, 450)
    },
    editorProps: {
      attributes: {
        class: 'document-editor-content',
        'aria-label': '页面正文',
      },
      transformPastedHTML: sanitizeSupportedHtml,
      handleKeyDown: (view, event) => {
        if (!vimEnabledRef.current || event.metaKey || event.ctrlKey || event.altKey) return false
        if (event.key === 'Escape') {
          event.preventDefault()
          setSearchOpen(false)
          changeVimMode('normal')
          return true
        }
        if (vimModeRef.current === 'insert') return false
        if (event.key === 'i') {
          event.preventDefault()
          changeVimMode('insert')
          return true
        }
        if (event.key === '/') {
          event.preventDefault()
          setSearchQuery('')
          setSearchOpen(true)
          return true
        }
        if (event.key === 'g') {
          event.preventDefault()
          if (pendingVimKey.current === 'g') {
            pendingVimKey.current = undefined
            moveSelection(view, Selection.atStart(view.state.doc))
          } else {
            pendingVimKey.current = 'g'
          }
          return true
        }
        if (event.key === 'd') {
          event.preventDefault()
          if (pendingVimKey.current === 'd') {
            pendingVimKey.current = undefined
            deleteCurrentBlock(view)
          } else {
            pendingVimKey.current = 'd'
          }
          return true
        }
        if (pendingVimKey.current === 'd' && event.key === 'w') {
          event.preventDefault()
          pendingVimKey.current = undefined
          deleteWord(view)
          return true
        }
        pendingVimKey.current = undefined
        if (event.key === 'G') {
          event.preventDefault()
          moveSelection(view, Selection.atEnd(view.state.doc))
          return true
        }
        if (event.key === 'h' || event.key === 'l') {
          event.preventDefault()
          moveHorizontal(view, event.key === 'h' ? -1 : 1)
          return true
        }
        if (event.key === 'j' || event.key === 'k') {
          event.preventDefault()
          moveVertical(view, event.key === 'k' ? -1 : 1)
          return true
        }
        if (event.key === 'x') {
          event.preventDefault()
          deleteCharacter(view)
          return true
        }
        if (event.key === 'u') {
          event.preventDefault()
          queueMicrotask(() => editor?.commands.undo?.())
          return true
        }
        event.preventDefault()
        return true
      },
    },
  }, [session.document, session.provider, loadAsset])

  const incomingContentSignature = serializeContent(content)
  useEffect(() => {
    if (!editor || !content) return
    const currentContent = editor.getJSON()
    if (serializeContent(currentContent) === incomingContentSignature) return

    // The content prop only changes after storage has accepted a local save or
    // after sync/revision restore has replaced the stored document. Local saves
    // already match the editor, so a difference here is an external replacement
    // that also needs to refresh the persistent Yjs document.
    clearTimeout(saveTimer.current)
    editor.commands.setContent(content, { emitUpdate: false })
    latestJson.current = editor.getJSON()
  }, [content, editor, incomingContentSignature])

  useEffect(() => () => {
    clearTimeout(saveTimer.current)
    if (latestJson.current) onChangeRef.current?.(latestJson.current)
  }, [])

  useEffect(() => registerFlushHandler(async () => {
    clearTimeout(saveTimer.current)
    if (latestJson.current) await onChangeRef.current?.(latestJson.current)
  }), [])

  const firstNode = editor?.state.doc.firstChild
  const duplicateTitle = firstNode?.type.name === 'heading' && firstNode.attrs.level === 1 && firstNode.textContent.trim() === pageTitle.trim()

  useEffect(() => {
    changeVimMode(vimEnabled ? 'normal' : 'insert')
    setSearchOpen(false)
  }, [vimEnabled])

  const findNext = () => {
    if (!editor || !searchQuery.trim()) return
    const query = searchQuery.toLocaleLowerCase()
    const from = editor.state.selection.to
    const matches: Array<{ from: number; to: number }> = []
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return
      const text = node.text.toLocaleLowerCase()
      let index = text.indexOf(query)
      while (index >= 0) {
        matches.push({ from: pos + index, to: pos + index + query.length })
        index = text.indexOf(query, index + Math.max(1, query.length))
      }
    })
    const match = matches.find((item) => item.from >= from) ?? matches[0]
    if (!match) return
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, match.from, match.to)).scrollIntoView())
    editor.commands.focus()
    changeVimMode('normal')
  }

  return <div className={`document-editor ${duplicateTitle ? 'duplicate-title' : ''}`}>
    {(session.status === 'connecting' || session.status === 'error') && <span className={`collaboration-status ${session.status}`}>{statusLabels[session.status]}</span>}
    <EditorContent editor={editor} />
    {vimEnabled && <div className="vim-status" aria-live="polite"><strong>{vimMode === 'normal' ? 'NORMAL' : 'INSERT'}</strong><span>{vimMode === 'normal' ? 'i 插入 · / 搜索 · Esc 保持普通模式' : 'Esc 返回普通模式'}</span></div>}
    {vimEnabled && searchOpen && <form className="vim-search" role="search" onSubmit={(event) => { event.preventDefault(); findNext() }}>
      <span>/</span><input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setSearchOpen(false); editor?.commands.focus() } }} aria-label="Vim 搜索" />
      <button type="submit">查找下一个</button>
    </form>}
  </div>
}

function serializeContent(content: Record<string, unknown> | string | undefined) {
  return typeof content === 'string' ? content : JSON.stringify(content ?? null)
}

type ProseMirrorView = Editor['view']

function moveSelection(view: ProseMirrorView, selection: Selection) {
  view.dispatch(view.state.tr.setSelection(selection).scrollIntoView())
}

function moveHorizontal(view: ProseMirrorView, direction: -1 | 1) {
  const position = Math.max(0, Math.min(view.state.doc.content.size, view.state.selection.head + direction))
  moveSelection(view, Selection.near(view.state.doc.resolve(position), direction))
}

function moveVertical(view: ProseMirrorView, direction: -1 | 1) {
  const coordinates = view.coordsAtPos(view.state.selection.head)
  const target = view.posAtCoords({ left: coordinates.left, top: direction < 0 ? coordinates.top - 20 : coordinates.bottom + 20 })
  if (target) moveSelection(view, Selection.near(view.state.doc.resolve(target.pos), direction))
}

function currentTextblockRange(state: EditorState) {
  const { $head } = state.selection
  for (let depth = $head.depth; depth > 0; depth -= 1) {
    if ($head.node(depth).isTextblock) return { from: $head.before(depth), to: $head.after(depth), textEnd: $head.end(depth) }
  }
  return undefined
}

function deleteCurrentBlock(view: ProseMirrorView) {
  const range = currentTextblockRange(view.state)
  if (range) view.dispatch(view.state.tr.delete(range.from, range.to).scrollIntoView())
}

function deleteWord(view: ProseMirrorView) {
  const range = currentTextblockRange(view.state)
  if (!range) return
  const from = view.state.selection.head
  const remaining = view.state.doc.textBetween(from, range.textEnd, '', '')
  const length = remaining.match(/^\s+|^[^\s]+\s*/u)?.[0].length ?? 0
  if (length) view.dispatch(view.state.tr.delete(from, Math.min(range.textEnd, from + length)).scrollIntoView())
}

function deleteCharacter(view: ProseMirrorView) {
  const range = currentTextblockRange(view.state)
  if (!range) return
  const from = view.state.selection.head
  if (from < range.textEnd) view.dispatch(view.state.tr.delete(from, from + 1).scrollIntoView())
}
