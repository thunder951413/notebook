import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { Button } from '@fluentui/react-components'
import { Attach20Regular, Clipboard20Regular, Dismiss16Regular, Document20Regular, Image20Regular, Sparkle20Regular } from '@fluentui/react-icons'
import type { NotebookSummary, PageSummary } from '../model'
import { aiConfigured, completeAI } from '../ai/completion'
import {
  entryFromFile,
  entryFromText,
  inboxLocations,
  inboxMessages,
  locationsForModel,
  parseInboxChoices,
  readInboxShortcut,
  saveInboxShortcut,
  shortcutFromKeyEvent,
  shortcutLabel,
  type InboxChoice,
  type InboxEntry,
  type InboxLocation,
} from '../ai/inbox'
import { failureMessage } from './OrganizePanel'
import { keyHint } from '../shell/keys'

export interface InboxFiling { entry: InboxEntry; location: InboxLocation; newFolder?: string; title: string; tags: string[] }
export interface InboxOutcome { created: Array<{ entryId: string; pageId: string }>; failed: Array<{ entryId: string; message: string }> }

const LAST_LOCATION_KEY = 'notebook-inbox-last-location-v1'
const readLastLocation = () => { try { return localStorage.getItem(LAST_LOCATION_KEY) ?? undefined } catch { return undefined } }

function formatSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * AI 收纳: whatever was copied or dropped becomes notes. The AI proposes a
 * place, title and tags for each; nothing is saved until “放好”.
 */
export function InboxDialog({ entries, onEntriesChange, pages, notebooks, tags, htmlToMarkdown, onReadClipboard, onPickFiles, onFile, onOpenPage, onClose, openAISettings }: {
  entries: InboxEntry[]
  onEntriesChange(entries: InboxEntry[]): void
  pages: PageSummary[]
  notebooks: NotebookSummary[]
  tags: string[]
  htmlToMarkdown(html: string): string
  /** Undefined where the clipboard cannot be read (browser build). */
  onReadClipboard?: () => Promise<number>
  onPickFiles(): void
  onFile(items: InboxFiling[], onProgress: (done: number, total: number) => void): Promise<InboxOutcome>
  onOpenPage(pageId: string): void
  onClose(): void
  openAISettings(): void
}) {
  const locations = useMemo(() => inboxLocations(pages, notebooks), [notebooks, pages])
  const [choices, setChoices] = useState<Map<string, InboxChoice>>(() => new Map())
  const [included, setIncluded] = useState<Set<string>>(() => new Set())
  const [thinking, setThinking] = useState<string>()
  const [aiError, setAiError] = useState<string>()
  const [request, setRequest] = useState('')
  const [applying, setApplying] = useState<string>()
  const [outcome, setOutcome] = useState<InboxOutcome & { titles: Map<string, string> }>()
  const [notice, setNotice] = useState<string>()
  const [dragging, setDragging] = useState(false)
  const abort = useRef<AbortController | undefined>(undefined)
  const configured = aiConfigured()
  useEffect(() => () => abort.current?.abort(), [])

  const fallbackKey = () => {
    const last = readLastLocation()
    return locations.some((location) => location.key === last) ? last! : locations[0]?.key ?? ''
  }


  const classify = async (targets: InboxEntry[], extra = request) => {
    if (!targets.length || !locations.length) return
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setAiError(undefined)
    setThinking(`AI 正在判断 ${targets.length} 项该放哪里…`)
    try {
      const shown = locationsForModel(locations, pages)
      const answer = await completeAI(inboxMessages(targets, shown, tags, extra), controller.signal)
      const parsed = parseInboxChoices(answer, targets, shown)
      setChoices((current) => {
        const next = new Map(current)
        for (const [id, choice] of parsed) next.set(id, choice)
        return next
      })
      if (parsed.size < targets.length) setAiError(`${targets.length - parsed.size} 项 AI 没有给出位置，请手动选择`)
    } catch (cause) {
      if (!controller.signal.aborted) setAiError(failureMessage(cause))
    } finally {
      if (abort.current === controller) setThinking(undefined)
    }
  }

  // New entries: included by default, placed at the last-used place until the AI answers.
  const latest = useRef({ choices, configured, fallbackKey, classify })
  latest.current = { choices, configured, fallbackKey, classify }
  useEffect(() => {
    const { choices: known, configured: useAI, fallbackKey: place, classify: run } = latest.current
    const fresh = entries.filter((entry) => !known.has(entry.id))
    if (!fresh.length) return
    setIncluded((current) => new Set([...current, ...fresh.map((entry) => entry.id)]))
    setChoices((current) => {
      const next = new Map(current)
      for (const entry of fresh) next.set(entry.id, { title: entry.title, locationKey: place(), tags: [] })
      return next
    })
    if (useAI) void run(fresh)
  }, [entries])

  const addFiles = async (files: File[]) => {
    const added: InboxEntry[] = []
    for (const file of files) {
      if (!file.name && !file.size) continue
      added.push(entryFromFile(file.name || '未命名文件', new Uint8Array(await file.arrayBuffer()), htmlToMarkdown))
    }
    if (added.length) onEntriesChange([...entries, ...added])
  }
  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    setDragging(false)
    const files = [...event.dataTransfer.files]
    if (files.length) { void addFiles(files); return }
    const entry = entryFromText(event.dataTransfer.getData('text/plain'), event.dataTransfer.getData('text/html') || undefined, htmlToMarkdown)
    if (entry) onEntriesChange([...entries, entry])
  }
  const onPaste = (event: ClipboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, select')) return
    event.preventDefault()
    const files = [...event.clipboardData.files]
    if (files.length) { void addFiles(files); return }
    const entry = entryFromText(event.clipboardData.getData('text/plain'), event.clipboardData.getData('text/html') || undefined, htmlToMarkdown)
    if (entry) onEntriesChange([...entries, entry])
  }
  const update = (id: string, change: Partial<InboxChoice>) => setChoices((current) => {
    const next = new Map(current)
    next.set(id, { ...next.get(id)!, ...change })
    return next
  })
  const remove = (id: string) => onEntriesChange(entries.filter((entry) => entry.id !== id))

  const ready = entries.filter((entry) => included.has(entry.id) && locations.some((location) => location.key === choices.get(entry.id)?.locationKey))
  const file = async () => {
    if (!ready.length || applying) return
    setApplying('正在保存…')
    const items = ready.map((entry) => {
      const choice = choices.get(entry.id)!
      return { entry, location: locations.find((location) => location.key === choice.locationKey)!, newFolder: choice.newFolder, title: choice.title.trim() || entry.title, tags: choice.tags }
    })
    try {
      const result = await onFile(items, (done, total) => setApplying(`正在保存 ${done} / ${total}`))
      try { localStorage.setItem(LAST_LOCATION_KEY, items[items.length - 1]!.location.key) } catch { /* storage unavailable */ }
      setOutcome({ ...result, titles: new Map(items.map((item) => [item.entry.id, item.title])) })
      const done = new Set(result.created.map((item) => item.entryId))
      onEntriesChange(entries.filter((entry) => !done.has(entry.id)))
    } catch (cause) {
      setNotice(failureMessage(cause))
    } finally {
      setApplying(undefined)
    }
  }

  const readClipboard = async () => {
    if (!onReadClipboard) return
    const count = await onReadClipboard().catch(() => 0)
    setNotice(count ? undefined : '剪贴板里没有可以收纳的内容')
  }

  return <div className="settings-backdrop" role="presentation" onKeyDown={(event: KeyboardEvent) => { if (event.key === 'Escape' && !applying) onClose() }}>
    <section
      className={`settings-dialog inbox-dialog ${dragging ? 'dragging' : ''}`}
      role="dialog"
      aria-label="AI 收纳"
      tabIndex={-1}
      onPaste={onPaste}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true) }}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false) }}
      onDrop={onDrop}
    >
      <header className="inbox-head">
        <div className="assistant-title"><Sparkle20Regular /><h2>AI 收纳</h2></div>
        <ShortcutSetting />
        <Button appearance="subtle" onClick={onClose} disabled={Boolean(applying)}>{outcome && !entries.length ? '完成' : '关闭'}</Button>
      </header>

      {outcome && <div className="inbox-outcome" role="status">
        <strong>已放好 {outcome.created.length} 项{outcome.failed.length ? `，${outcome.failed.length} 项失败` : ''}</strong>
        <ul>
          {outcome.created.map((item) => <li key={item.entryId}><button type="button" onClick={() => onOpenPage(item.pageId)}>{outcome.titles.get(item.entryId)}</button></li>)}
          {outcome.failed.map((item) => <li key={item.entryId} className="failed">{outcome.titles.get(item.entryId)}：{item.message}</li>)}
        </ul>
      </div>}

      <div className={`inbox-drop ${entries.length ? 'compact' : ''}`}>
        <span>{entries.length ? `继续拖入文件，或按 ${keyHint('paste')} 粘贴` : `把文件拖到这里，或按 ${keyHint('paste')} 粘贴文字、图片`}</span>
        <div>
          {onReadClipboard && <button type="button" onClick={() => void readClipboard()}><Clipboard20Regular />读取剪贴板</button>}
          <button type="button" onClick={onPickFiles}><Attach20Regular />选择文件</button>
        </div>
      </div>

      {entries.length > 0 && <>
        <div className="inbox-toolbar">
          {configured
            ? <>
              <input value={request} placeholder="补充要求（可选），例如“都放到项目资料下面”" aria-label="补充要求" onChange={(event) => setRequest(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void classify(entries) }} />
              <button type="button" disabled={Boolean(thinking)} onClick={() => void classify(entries)}>重新判断</button>
            </>
            : <span>配置 AI 后可以自动判断位置、标题和标签。<button type="button" onClick={openAISettings}>配置 AI</button></span>}
        </div>
        {thinking && <div className="assistant-busy inbox-status" role="status">{thinking}</div>}
        {aiError && <div className="inbox-status error" role="alert">{aiError}</div>}
        <ul className="inbox-list" aria-label="待收纳">
          {entries.map((entry) => {
            const choice = choices.get(entry.id)
            if (!choice) return null
            const Icon = entry.kind === 'image' ? Image20Regular : entry.kind === 'file' ? Attach20Regular : Document20Regular
            return <li key={entry.id} className={included.has(entry.id) ? undefined : 'excluded'}>
              <input type="checkbox" aria-label={`收纳“${choice.title}”`} checked={included.has(entry.id)} onChange={() => setIncluded((current) => { const next = new Set(current); if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id); return next })} />
              <div className="inbox-item">
                <div className="inbox-item-head">
                  <Icon className="inbox-kind" />
                  <input className="inbox-title" aria-label="标题" value={choice.title} onChange={(event) => update(entry.id, { title: event.currentTarget.value })} />
                  <button type="button" className="inbox-remove" aria-label="移除" onClick={() => remove(entry.id)}><Dismiss16Regular /></button>
                </div>
                <div className="inbox-item-meta">
                  <span className="inbox-source">{entry.source}{entry.attachment ? ` · ${formatSize(entry.attachment.data.byteLength)}` : ''}</span>
                  {entry.kind === 'note' && <span className="inbox-preview">{entry.markdown.slice(0, 400).replace(/\s+/g, ' ').slice(0, 80)}</span>}
                </div>
                <div className="inbox-item-fields">
                  <select aria-label="放到" value={choice.newFolder ? '__new__' : choice.locationKey} onChange={(event) => { const value = event.currentTarget.value; if (value !== '__new__') update(entry.id, { locationKey: value, newFolder: undefined }) }}>
                    {choice.newFolder && <option value="__new__">新建目录「{choice.newFolder}」于 {locations.find((location) => location.key === choice.locationKey)?.label}</option>}
                    {locations.map((location) => <option key={location.key} value={location.key}>{location.label}</option>)}
                  </select>
                  <input className="inbox-tags" aria-label="标签" placeholder="标签，用逗号分隔" value={choice.tags.join('，')} onChange={(event) => update(entry.id, { tags: event.currentTarget.value.split(/[,，\s]+/).map((tag) => tag.replace(/^#/, '')).filter(Boolean) })} />
                </div>
                {choice.reason && <small className="inbox-reason">{choice.reason}</small>}
              </div>
            </li>
          })}
        </ul>
      </>}

      {notice && <p className="inbox-status error" role="alert">{notice}</p>}
      {entries.length > 0 && <footer className="inbox-foot">
        <span>{ready.length} 项将保存为笔记{entries.some((entry) => entry.attachment) ? '，文件作为附件放在笔记里' : ''}</span>
        <Button appearance="primary" disabled={!ready.length || Boolean(applying)} onClick={() => void file()}>{applying ?? `放好 ${ready.length} 项`}</Button>
      </footer>}
    </section>
  </div>
}

/** The global shortcut: shown, changed by pressing a new combination, or turned off. */
function ShortcutSetting() {
  const bridge = window.notebookDesktop?.inbox
  const [current, setCurrent] = useState(readInboxShortcut)
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string>()
  if (!bridge) return null
  const apply = async (accelerator: string | null) => {
    setError(undefined)
    try {
      await bridge.setShortcut(accelerator)
      saveInboxShortcut(accelerator)
      setCurrent(accelerator)
      setRecording(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法设置快捷键')
    }
  }
  return <div className="inbox-shortcut" title="在任何应用里按下这个快捷键：读取剪贴板里的文字、图片或文件，打开 AI 收纳">
    <span>全局快捷键</span>
    {recording
      ? <button type="button" className="recording" autoFocus onBlur={() => setRecording(false)} onKeyDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Escape') { setRecording(false); return }
        const accelerator = shortcutFromKeyEvent(event)
        if (accelerator) void apply(accelerator)
      }}>请按下新的组合键…</button>
      : <button type="button" onClick={() => setRecording(true)}><kbd>{shortcutLabel(current)}</kbd>修改</button>}
    {current && !recording && <button type="button" onClick={() => void apply(null)}>关闭</button>}
    {error && <span className="inbox-shortcut-error" role="alert">{error}</span>}
  </div>
}
