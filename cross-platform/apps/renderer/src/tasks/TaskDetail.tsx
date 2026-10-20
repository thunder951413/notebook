import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { Button, Checkbox, Input } from '@fluentui/react-components'
import { Add16Regular, Dismiss16Regular, Star20Filled, Star20Regular } from '@fluentui/react-icons'
import type { TaskStep } from '@notebook/domain'
import type { PageSummary } from '../model'

interface TaskDetailProps {
  task: PageSummary
  loadSteps(pageId: string): Promise<TaskStep[]>
  saveSteps(pageId: string, steps: TaskStep[]): Promise<void>
  updateTask(patch: Record<string, unknown>): Promise<void>
}

/** Text edits inside a step are saved this long after the last keystroke; checks and added or removed steps save at once. */
const STEP_TEXT_SAVE_DELAY_MS = 500

type ScheduleField = 'dueAt' | 'reminderAt' | 'recurrenceRule'

const ADD_LABEL: Record<ScheduleField, string> = { dueAt: '截止时间', reminderAt: '提醒', recurrenceRule: '重复' }

/** The todo is its own text, with no separate title. Schedule fields sit on the right and appear only once set or added. */
export function TaskDetail({ task, loadSteps, saveSteps, updateTask }: TaskDetailProps) {
  const [item, setItem] = useState(task.title)
  const [note, setNote] = useState(task.preview)
  const [revealed, setRevealed] = useState<ReadonlySet<ScheduleField>>(new Set())
  useEffect(() => { setItem(task.title) }, [task.id, task.title])
  useEffect(() => { setNote(task.preview) }, [task.id, task.preview])

  const commitItem = () => { if (item.trim() !== task.title) void updateTask({ title: item.trim() }) }
  const recurring = Boolean(task.recurrenceRule && task.recurrenceRule !== 'none')
  const shown = (field: ScheduleField) => revealed.has(field) || (field === 'recurrenceRule' ? recurring : Boolean(task[field]))
  const reveal = (field: ScheduleField) => setRevealed((current) => new Set(current).add(field))
  const clear = (field: ScheduleField) => {
    setRevealed((current) => { const next = new Set(current); next.delete(field); return next })
    void updateTask({ [field]: field === 'recurrenceRule' ? 'none' : undefined })
  }
  const setDate = (field: 'dueAt' | 'reminderAt', value: string) => {
    if (field === 'reminderAt' && value && !window.notebookDesktop && 'Notification' in window && Notification.permission === 'default') void Notification.requestPermission()
    void updateTask({ [field]: value ? new Date(value).toISOString() : undefined })
  }
  const missing = (['dueAt', 'reminderAt', 'recurrenceRule'] as const).filter((field) => !shown(field))

  return <div className="task-detail">
    <div className="task-main">
      <div className="task-heading">
        <Checkbox className="task-complete" checked={Boolean(task.completedAt)} onChange={(_, data) => void updateTask({ completedAt: data.checked ? new Date().toISOString() : undefined })} aria-label="完成待办" />
        <AutoTextarea
          className="task-item-input"
          aria-label="待办事项"
          placeholder="要做什么？"
          autoFocus={!task.title.trim()}
          value={item}
          onChange={(event) => setItem(event.target.value)}
          onBlur={commitItem}
          onKeyDown={(event) => {
            if (isComposing(event) || event.key !== 'Enter' || event.shiftKey) return
            event.preventDefault()
            if (event.ctrlKey || event.metaKey) insertNewline(event.currentTarget, setItem)
            else event.currentTarget.blur()
          }}
        />
        <Button appearance="subtle" icon={task.important ? <Star20Filled /> : <Star20Regular />} aria-label="重要" aria-pressed={Boolean(task.important)} onClick={() => void updateTask({ important: !task.important })} />
      </div>
      <AutoTextarea className="task-note" aria-label="备注" placeholder="添加备注" value={note} onChange={(event) => setNote(event.target.value)} onBlur={() => { if (note !== task.preview) void updateTask({ preview: note }) }} />
      <TaskSteps taskId={task.id} loadSteps={loadSteps} saveSteps={saveSteps} />
    </div>
    <aside className="task-aside" aria-label="时间">
      {shown('dueAt') && <ScheduleRow label="截止时间" onClear={() => clear('dueAt')}>
        <Input type="datetime-local" aria-label="截止时间" autoFocus={!task.dueAt} value={localInputValue(task.dueAt)} onChange={(_, data) => setDate('dueAt', data.value)} />
      </ScheduleRow>}
      {shown('reminderAt') && <ScheduleRow label="提醒时间" onClear={() => clear('reminderAt')}>
        <Input type="datetime-local" aria-label="提醒时间" autoFocus={!task.reminderAt} value={localInputValue(task.reminderAt)} onChange={(_, data) => setDate('reminderAt', data.value)} />
      </ScheduleRow>}
      {shown('recurrenceRule') && <ScheduleRow label="重复" onClear={() => clear('recurrenceRule')}>
        <select className="task-select" aria-label="重复" value={task.recurrenceRule ?? 'none'} onChange={(event) => void updateTask({ recurrenceRule: event.target.value })}><option value="none">不重复</option><option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option></select>
      </ScheduleRow>}
      {missing.length > 0 && <div className="task-aside-add">
        {missing.map((field) => <Button key={field} appearance="subtle" size="small" icon={<Add16Regular />} onClick={() => reveal(field)}>{ADD_LABEL[field]}</Button>)}
      </div>}
    </aside>
  </div>
}

function ScheduleRow({ label, onClear, children }: { label: string; onClear(): void; children: ReactNode }) {
  return <div className="task-schedule-row">
    <div className="task-schedule-label"><span>{label}</span><Button appearance="transparent" size="small" icon={<Dismiss16Regular />} aria-label={`移除${label}`} onClick={onClear} /></div>
    {children}
  </div>
}

/**
 * One editing area for the steps. Typing into the trailing empty row creates a step; Enter starts the next step,
 * splitting at the caret; Ctrl/⌘+Enter or Shift+Enter breaks the line; Backspace at the start of a step joins it
 * to the previous one. Empty steps are not saved.
 */
function TaskSteps({ taskId, loadSteps, saveSteps }: { taskId: string; loadSteps: TaskDetailProps['loadSteps']; saveSteps: TaskDetailProps['saveSteps'] }) {
  const [steps, setSteps] = useState<TaskStep[]>([])
  const [ready, setReady] = useState(false)
  const [draftId, setDraftId] = useState(() => crypto.randomUUID())
  const inputs = useRef(new Map<string, HTMLTextAreaElement>())
  const pendingFocus = useRef<{ id: string; caret: number } | undefined>(undefined)
  const pendingSave = useRef<{ timer: ReturnType<typeof setTimeout>; steps: TaskStep[] } | undefined>(undefined)

  useEffect(() => {
    let active = true
    setReady(false)
    void loadSteps(taskId).then((loaded) => {
      if (!active) return
      setSteps([...loaded].sort((a, b) => a.sortOrder - b.sortOrder))
      setReady(true)
    })
    return () => { active = false }
  }, [loadSteps, taskId])

  const persist = useCallback((next: TaskStep[]) => {
    void saveSteps(taskId, next.filter((step) => step.text.trim()).map((step, sortOrder) => ({ ...step, sortOrder })))
  }, [saveSteps, taskId])
  const flush = useCallback(() => {
    const pending = pendingSave.current
    if (!pending) return
    clearTimeout(pending.timer)
    pendingSave.current = undefined
    persist(pending.steps)
  }, [persist])
  useEffect(() => flush, [flush])

  const commit = (next: TaskStep[], mode: 'now' | 'debounced') => {
    setSteps(next)
    if (pendingSave.current) clearTimeout(pendingSave.current.timer)
    if (mode === 'now') { pendingSave.current = undefined; persist(next); return }
    pendingSave.current = { steps: next, timer: setTimeout(flush, STEP_TEXT_SAVE_DELAY_MS) }
  }
  const newStep = (text: string, id: string = crypto.randomUUID()): TaskStep => ({ id, pageId: taskId, text, checked: false, sortOrder: 0, createdAt: new Date().toISOString() })
  const focusAfterRender = (id: string, caret: number) => { pendingFocus.current = { id, caret } }
  const focusNow = (id: string | undefined, caret: 'start' | 'end') => {
    const input = id ? inputs.current.get(id) : undefined
    if (!input) return
    input.focus()
    const offset = caret === 'start' ? 0 : input.value.length
    input.setSelectionRange(offset, offset)
  }

  useLayoutEffect(() => {
    const target = pendingFocus.current
    const input = target && inputs.current.get(target.id)
    if (!target || !input) return
    pendingFocus.current = undefined
    input.focus()
    input.setSelectionRange(target.caret, target.caret)
  })

  const changeText = (index: number, text: string) => {
    if (index === steps.length) {
      if (!text) return
      // The draft row keeps its key and becomes this step, so focus and input-method composition carry over.
      commit([...steps, newStep(text, draftId)], 'now')
      setDraftId(crypto.randomUUID())
      return
    }
    commit(steps.map((step, i) => i === index ? { ...step, text } : step), 'debounced')
  }

  const onKeyDown = (index: number, event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(event)) return
    const input = event.currentTarget
    const current = steps[index]
    const previous = steps[index - 1]
    const collapsed = input.selectionStart === input.selectionEnd
    if (event.key === 'Enter') {
      if (event.shiftKey) return
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) { insertNewline(input, (text) => changeText(index, text)); return }
      if (!current) return
      const before = current.text.slice(0, input.selectionStart)
      const after = current.text.slice(input.selectionEnd)
      if (!after && index === steps.length - 1) {
        focusNow(draftId, 'start')
        return
      }
      const inserted = newStep(after)
      commit([...steps.slice(0, index), { ...current, text: before }, inserted, ...steps.slice(index + 1)], 'now')
      focusAfterRender(inserted.id, 0)
      return
    }
    if (event.key === 'Backspace' && current && collapsed && input.selectionStart === 0) {
      if (!previous && current.text) return
      event.preventDefault()
      if (previous) {
        focusAfterRender(previous.id, previous.text.length)
        commit([...steps.slice(0, index - 1), { ...previous, text: previous.text + current.text }, ...steps.slice(index + 1)], 'now')
      } else {
        focusAfterRender(steps[1]?.id ?? draftId, 0)
        commit(steps.slice(1), 'now')
      }
      return
    }
    if (event.key === 'ArrowUp' && previous && collapsed && input.selectionStart === 0) {
      event.preventDefault()
      focusNow(previous.id, 'end')
      return
    }
    if (event.key === 'ArrowDown' && current && collapsed && input.selectionStart === input.value.length) {
      event.preventDefault()
      focusNow(steps[index + 1]?.id ?? draftId, 'start')
    }
  }

  const rows = [...steps.map((step) => ({ id: step.id, step })), { id: draftId, step: undefined }]
  return <section className="task-steps" aria-label="步骤">
    <h2>步骤</h2>
    <div className="task-steps-area" onMouseDown={(event) => {
      if (event.target !== event.currentTarget) return
      event.preventDefault()
      focusNow(draftId, 'start')
    }}>
      {rows.map(({ id, step }, index) => <div className={['task-step', step ? '' : 'draft', step?.checked ? 'checked' : ''].filter(Boolean).join(' ')} key={id}>
        <Checkbox
          className="task-step-check"
          disabled={!step}
          checked={step?.checked ?? false}
          aria-label={step ? `完成步骤 ${step.text}` : '新步骤'}
          onChange={(_, data) => { if (step) commit(steps.map((other) => other.id === step.id ? { ...other, checked: Boolean(data.checked) } : other), 'now') }}
        />
        <AutoTextarea
          ref={(element) => { if (element) inputs.current.set(id, element); else inputs.current.delete(id) }}
          className="task-step-input"
          aria-label={step ? '步骤内容' : '添加步骤'}
          placeholder={step ? undefined : ready ? '添加步骤' : '正在加载步骤…'}
          disabled={!ready}
          value={step?.text ?? ''}
          onChange={(event) => changeText(index, event.target.value)}
          onKeyDown={(event) => onKeyDown(index, event)}
          onBlur={flush}
        />
        {step && <Button className="task-step-delete" appearance="subtle" size="small" icon={<Dismiss16Regular />} aria-label={`删除步骤 ${step.text}`} onClick={() => commit(steps.filter((other) => other.id !== step.id), 'now')} />}
      </div>)}
    </div>
  </section>
}

/** A textarea that grows with its content instead of scrolling. */
function AutoTextarea({ ref, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: (element: HTMLTextAreaElement | null) => void }) {
  const own = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    const element = own.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [props.value])
  return <textarea rows={1} {...props} ref={(element) => { own.current = element; ref?.(element) }} />
}

/** Enter while an input method is composing (pinyin and the like) confirms the candidate and must not act on the todo. */
function isComposing(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229
}

function insertNewline(input: HTMLTextAreaElement, apply: (text: string) => void) {
  const { selectionStart, selectionEnd, value } = input
  apply(`${value.slice(0, selectionStart)}\n${value.slice(selectionEnd)}`)
  requestAnimationFrame(() => input.setSelectionRange(selectionStart + 1, selectionStart + 1))
}

/** The value a datetime-local input expects: the stored instant in the viewer's local time. */
function localInputValue(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
