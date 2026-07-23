import { useEffect, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import Placeholder from '@tiptap/extension-placeholder'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { useCollaborativeDocument } from '../collaboration/useCollaborativeDocument'
import { createContentExtensions, type AssetLoader } from './extensions'
import { Button } from '@fluentui/react-components'
import {
  CheckboxChecked20Regular,
  Code20Regular,
  MathFormula20Regular,
  Table20Regular,
  TextBold20Regular,
  TextHeader220Regular,
  TextItalic20Regular,
  Image20Regular,
} from '@fluentui/react-icons'
import type { Asset } from '@notebook/domain'
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
  saveImage?: (file: File) => Promise<Asset>
}

const statusLabels = { loading: '正在载入离线副本', offline: '离线可编辑', connecting: '正在连接协作', connected: '实时协作已连接', error: '协作服务不可用 · 已离线保存' }

export function DocumentEditor({ workspaceId, pageId, pageTitle, content = initialContent, onChange, onDraft, forceRestore, loadAsset, saveImage }: DocumentEditorProps) {
  const session = useCollaborativeDocument(workspaceId, pageId)
  if (!session || session.status === 'loading') return <div className="editor-loading">正在载入离线副本…</div>
  return <ReadyDocumentEditor session={session} pageTitle={pageTitle} content={content} onChange={onChange} onDraft={onDraft} forceRestore={forceRestore} loadAsset={loadAsset} saveImage={saveImage} />
}

function ReadyDocumentEditor({ session, pageTitle, content, onChange, onDraft, forceRestore, loadAsset, saveImage }: Pick<DocumentEditorProps, 'pageTitle' | 'content' | 'onChange' | 'onDraft' | 'forceRestore' | 'loadAsset' | 'saveImage'> & { session: NonNullable<ReturnType<typeof useCollaborativeDocument>> }) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const imageInput = useRef<HTMLInputElement>(null)
  const latestJson = useRef<Record<string, unknown> | undefined>(undefined)
  const onChangeRef = useRef(onChange)
  const onDraftRef = useRef(onDraft)
  onChangeRef.current = onChange
  onDraftRef.current = onDraft
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

  const insertImage = async (file?: File) => {
    if (!file || !editor || !saveImage) return
    try {
      const asset = await saveImage(file)
      editor.chain().focus().insertContent({
        type: 'image',
        attrs: { src: `notebook-asset:${asset.id}`, legacyAssetId: asset.id, alt: file.name, title: file.name },
      }).run()
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '图片插入失败')
    } finally {
      if (imageInput.current) imageInput.current.value = ''
    }
  }

  return <div className={`document-editor ${duplicateTitle ? 'duplicate-title' : ''}`}>
    {(session.status === 'connecting' || session.status === 'error') && <span className={`collaboration-status ${session.status}`}>{statusLabels[session.status]}</span>}
    {editor && <div className="format-toolbar" role="toolbar" aria-label="文字格式">
      <div className="format-group" aria-label="文本样式">
        <Button size="small" appearance={editor.isActive('bold') ? 'primary' : 'subtle'} icon={<TextBold20Regular />} title="粗体" onClick={() => editor.chain().focus().toggleBold().run()}>粗体</Button>
        <Button size="small" appearance={editor.isActive('italic') ? 'primary' : 'subtle'} icon={<TextItalic20Regular />} title="斜体" onClick={() => editor.chain().focus().toggleItalic().run()}>斜体</Button>
        <Button size="small" appearance={editor.isActive('heading', { level: 2 }) ? 'primary' : 'subtle'} icon={<TextHeader220Regular />} title="二级标题" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>标题</Button>
      </div>
      <div className="format-group" aria-label="插入内容">
        {saveImage && <><input ref={imageInput} hidden type="file" accept="image/*" onChange={(event) => { void insertImage(event.target.files?.[0]) }} /><Button size="small" appearance="subtle" icon={<Image20Regular />} title="插入图片" onClick={() => imageInput.current?.click()}>图片</Button></>}
        <Button size="small" appearance={editor.isActive('taskList') ? 'primary' : 'subtle'} icon={<CheckboxChecked20Regular />} title="待办列表" onClick={() => editor.chain().focus().toggleTaskList().run()}>待办</Button>
        <Button size="small" appearance="subtle" icon={<Table20Regular />} title="插入表格" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>表格</Button>
        <Button size="small" appearance="subtle" icon={<MathFormula20Regular />} title="插入公式" onClick={() => editor.chain().focus().insertBlockMath({ latex: 'E = mc^2' }).run()}>公式</Button>
        <Button size="small" appearance={editor.isActive('codeBlock') ? 'primary' : 'subtle'} icon={<Code20Regular />} title="代码块" onClick={() => editor.chain().focus().toggleCodeBlock().run()}>代码</Button>
      </div>
    </div>}
    <EditorContent editor={editor} />
  </div>
}

function serializeContent(content: Record<string, unknown> | string | undefined) {
  return typeof content === 'string' ? content : JSON.stringify(content ?? null)
}
