import { useEffect, useState } from 'react'
import { Button, Checkbox, Field, Input, Textarea } from '@fluentui/react-components'
import { Add20Regular, Delete20Regular, Star20Filled, Star20Regular } from '@fluentui/react-icons'
import type { TaskStep } from '@notebook/domain'
import type { PageSummary } from '../model'

interface TaskDetailProps {
  task: PageSummary
  loadSteps(pageId: string): Promise<TaskStep[]>
  saveSteps(pageId: string, steps: TaskStep[]): Promise<void>
  updateTask(patch: Record<string, unknown>): Promise<void>
}

export function TaskDetail({ task, loadSteps, saveSteps, updateTask }: TaskDetailProps) {
  const [steps, setSteps] = useState<TaskStep[]>([])
  const [stepsReady, setStepsReady] = useState(false)
  const [newStep, setNewStep] = useState('')
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.preview)
  useEffect(() => {
    let active = true
    setStepsReady(false)
    void loadSteps(task.id).then((loaded) => {
      if (!active) return
      setSteps(loaded)
      setStepsReady(true)
    })
    return () => { active = false }
  }, [loadSteps, task.id])
  useEffect(() => { setTitle(task.title) }, [task.id, task.title])
  useEffect(() => { setDescription(task.preview) }, [task.id, task.preview])

  const commitSteps = (next: TaskStep[]) => {
    setSteps(next)
    void saveSteps(task.id, next)
  }
  const addStep = () => {
    const text = newStep.trim()
    if (!text) return
    commitSteps([...steps, { id: crypto.randomUUID(), pageId: task.id, text, checked: false, sortOrder: steps.length, createdAt: new Date().toISOString() }])
    setNewStep('')
  }
  const commitTitle = () => {
    const next = title.trim()
    if (!next) {
      setTitle(task.title)
      return
    }
    if (next !== task.title) void updateTask({ title: next })
  }

  return <div className="task-detail">
    <div className="task-heading">
      <Checkbox checked={Boolean(task.completedAt)} onChange={(_, data) => void updateTask({ completedAt: data.checked ? new Date().toISOString() : undefined })} aria-label="完成任务" />
      <div><Input className="task-title-input" value={title} aria-label="任务标题" onChange={(_, data) => setTitle(data.value)} onBlur={commitTitle} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /><p>{task.preview || '添加任务说明和执行步骤。'}</p></div>
      <Button appearance="subtle" icon={task.important ? <Star20Filled /> : <Star20Regular />} aria-label="重要" onClick={() => void updateTask({ important: !task.important })} />
    </div>
    <div className="task-fields">
      <Field label="截止时间"><Input type="datetime-local" value={task.dueAt ? task.dueAt.slice(0, 16) : ''} onChange={(_, data) => void updateTask({ dueAt: data.value ? new Date(data.value).toISOString() : undefined })} /></Field>
      <Field label="提醒时间"><Input type="datetime-local" value={task.reminderAt ? task.reminderAt.slice(0, 16) : ''} onChange={(_, data) => { if (!window.notebookDesktop && 'Notification' in window && Notification.permission === 'default') void Notification.requestPermission(); void updateTask({ reminderAt: data.value ? new Date(data.value).toISOString() : undefined }) }} /></Field>
      <Field label="重复"><select className="task-select" aria-label="重复" value={task.recurrenceRule ?? 'none'} onChange={(event) => void updateTask({ recurrenceRule: event.target.value })}><option value="none">不重复</option><option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option></select></Field>
      <Field label="任务说明"><Textarea value={description} resize="vertical" onChange={(_, data) => setDescription(data.value)} onBlur={() => void updateTask({ preview: description })} /></Field>
    </div>
    <section className="task-steps"><h2>步骤</h2>
      {steps.map((step) => <div className="task-step" key={step.id}><Checkbox checked={step.checked} onChange={(_, data) => commitSteps(steps.map((item) => item.id === step.id ? { ...item, checked: Boolean(data.checked) } : item))} label={step.text} /><Button appearance="subtle" icon={<Delete20Regular />} aria-label={`删除 ${step.text}`} onClick={() => commitSteps(steps.filter((item) => item.id !== step.id))} /></div>)}
      <div className="add-step"><Input disabled={!stepsReady} value={newStep} onChange={(_, data) => setNewStep(data.value)} onKeyDown={(event) => { if (event.key === 'Enter') addStep() }} placeholder={stepsReady ? '添加步骤' : '正在加载步骤…'} /><Button disabled={!stepsReady} icon={<Add20Regular />} onClick={addStep}>添加</Button></div>
    </section>
  </div>
}
