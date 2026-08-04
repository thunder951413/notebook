import { useState } from 'react'
import { Button } from '@fluentui/react-components'
import type { PageSummary } from '../model'
import { descendantsOf, flattenPageTree } from '../pageTree'

export function MovePageDialog({ page, pages, notebooks, onClose, onMove }: {
  page: PageSummary
  pages: PageSummary[]
  notebooks: Array<{ id: string; name: string; sections: Array<{ id: string; name: string }> }>
  onClose: () => void
  onMove: (targetPageId: string, position: 'before' | 'inside' | 'after') => Promise<void>
}) {
  const excluded = new Set([page.id, ...descendantsOf(pages, page.id)])
  const targets = notebooks.flatMap((notebook) => notebook.sections.flatMap((section) => {
    const sectionPages = pages.filter((candidate) => candidate.sectionId === section.id && !excluded.has(candidate.id))
    return flattenPageTree(sectionPages, new Set(sectionPages.map((candidate) => candidate.id))).map(({ page: candidate, depth }) => ({
      page: candidate,
      label: `${notebook.name} / ${'\u00a0\u00a0'.repeat(depth)}${candidate.title || '无标题页面'}`,
    }))
  }))
  const [targetPageId, setTargetPageId] = useState(targets[0]?.page.id ?? '')
  const [position, setPosition] = useState<'before' | 'inside' | 'after'>('inside')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const submit = async () => {
    if (!targetPageId || saving) return
    setSaving(true)
    setError(undefined)
    try { await onMove(targetPageId, position) } catch (cause) { setError(cause instanceof Error ? cause.message : '无法移动页面'); setSaving(false) }
  }
  return <div className="settings-backdrop" role="presentation"><section className="settings-dialog create-item-dialog move-page-dialog" role="dialog" aria-label="移动页面"><div><h2>移动“{page.title}”</h2><Button appearance="subtle" onClick={onClose}>取消</Button></div>{targets.length ? <><label className="dialog-field"><span>目标页面</span><select autoFocus aria-label="目标页面" value={targetPageId} onChange={(event) => setTargetPageId(event.currentTarget.value)}>{targets.map((target) => <option key={target.page.id} value={target.page.id}>{target.label}</option>)}</select></label><label className="dialog-field"><span>放置位置</span><select aria-label="放置位置" value={position} onChange={(event) => setPosition(event.currentTarget.value as 'before' | 'inside' | 'after')}><option value="inside">作为目标页面的子页面</option><option value="before">放在目标页面之前</option><option value="after">放在目标页面之后</option></select></label></> : <p>没有可用的目标页面。</p>}{error && <p role="alert">{error}</p>}<Button appearance="primary" disabled={!targetPageId || saving} onClick={() => void submit()}>{saving ? '正在移动' : '移动到这里'}</Button></section></div>
}
