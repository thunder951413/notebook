import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { documentToMarkdown, markdownToDocument } from './extensions'
import { Editor } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import { createContentExtensions } from './extensions'
import { useCollaborativeDocument } from '../collaboration/useCollaborativeDocument'

export interface MarkdownSourceEditorProps {
  workspaceId: string
  pageId: string
  content: Record<string, unknown>
  onChange: (document: Record<string, unknown>) => void
}

export default function MarkdownSourceEditor(props: MarkdownSourceEditorProps) {
  const session = useCollaborativeDocument(props.workspaceId, props.pageId)
  if (!session || session.status === 'loading') return <div className="editor-loading">正在载入 Markdown 源码…</div>
  return <ReadyMarkdownSourceEditor {...props} document={session.document} />
}

function ReadyMarkdownSourceEditor({ content, onChange, document }: MarkdownSourceEditorProps & { document: import('yjs').Doc }) {
  const host = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  useEffect(() => {
    if (!host.current) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let applyingSource = false
    const tiptap = new Editor({ extensions: [...createContentExtensions(true), Collaboration.configure({ document })] })
    if (JSON.stringify(tiptap.getJSON()) !== JSON.stringify(content)) {
      // A completed SSH sync or revision restore is authoritative over the
      // persisted Yjs view. Hydrate it without reporting a user edit.
      tiptap.commands.setContent(content, { emitUpdate: false })
    }
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: documentToMarkdown(tiptap.getJSON()),
        extensions: [
          lineNumbers(), history(), markdown(), EditorView.lineWrapping,
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            clearTimeout(timer)
            timer = setTimeout(() => {
              const json = markdownToDocument(update.state.doc.toString())
              applyingSource = true
              tiptap.commands.setContent(json)
              applyingSource = false
              onChangeRef.current(json)
            }, 450)
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
    const reflectRemote = () => {
      if (applyingSource || view.hasFocus) return
      const next = documentToMarkdown(tiptap.getJSON())
      if (next !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
    }
    tiptap.on('update', reflectRemote)
    return () => { clearTimeout(timer); tiptap.off('update', reflectRemote); tiptap.destroy(); view.destroy() }
  }, [content, document])
  return <div ref={host} className="source-editor" aria-label="Markdown 源码编辑器" />
}
