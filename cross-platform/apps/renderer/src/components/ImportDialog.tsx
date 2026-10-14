import { useMemo, useState } from 'react'
import { Button } from '@fluentui/react-components'
import type { NotebookSummary, PageSummary } from '../model'
import { flattenPageTree } from '../pageTree'
import { importSummary, textImportKind, TEXT_IMPORT_MAX_BYTES, type TextImportSkip } from '../data/textImport'
import type { ImportFile } from '../data/transfer'

export interface ImportTarget { sectionId: string; parentPageId?: string }

function formatSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Confirms a Markdown / text / HTML import: which files, and where in the
 * tree they go. Unsupported files are listed and skipped.
 */
export function ImportDialog({ files, pages, notebooks, initialTarget, onClose, onImport }: {
  files: ImportFile[]
  pages: PageSummary[]
  notebooks: NotebookSummary[]
  initialTarget?: ImportTarget
  onClose: () => void
  onImport: (files: ImportFile[], target: ImportTarget) => Promise<{ createdIds: string[]; skipped: TextImportSkip[] }>
}) {
  const targets = useMemo(() => notebooks.flatMap((notebook) => notebook.sections.flatMap((section, sectionIndex) => {
    const sectionPages = pages.filter((page) => page.sectionId === section.id && page.kind !== 'task')
    const top = sectionIndex === 0 || notebook.sections.length === 1
      ? [{ key: `section:${section.id}`, target: { sectionId: section.id } as ImportTarget, label: `${notebook.name}（顶层）` }]
      : [{ key: `section:${section.id}`, target: { sectionId: section.id } as ImportTarget, label: `${notebook.name} / ${section.name}（顶层）` }]
    return [...top, ...flattenPageTree(sectionPages, new Set(sectionPages.map((page) => page.id))).map(({ page, depth }) => ({
      key: `page:${page.id}`,
      target: { sectionId: section.id, parentPageId: page.id } as ImportTarget,
      label: `${notebook.name} / ${'  '.repeat(depth)}${page.title || '无标题页面'}`,
    }))]
  })), [notebooks, pages])
  const initialKey = initialTarget ? (initialTarget.parentPageId ? `page:${initialTarget.parentPageId}` : `section:${initialTarget.sectionId}`) : targets[0]?.key ?? ''
  const [targetKey, setTargetKey] = useState(targets.some((item) => item.key === initialKey) ? initialKey : targets[0]?.key ?? '')
  const rows = files.map((file) => ({
    file,
    problem: !textImportKind(file.name) ? '不支持的格式' : file.data.byteLength > TEXT_IMPORT_MAX_BYTES ? '超过 5 MB' : undefined,
  }))
  const importable = rows.filter((row) => !row.problem)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>()
  const [error, setError] = useState<string>()
  const submit = async () => {
    const target = targets.find((item) => item.key === targetKey)?.target
    if (!target || !importable.length || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const outcome = await onImport(importable.map((row) => row.file), target)
      const skipped = [...rows.filter((row) => row.problem).map((row) => ({ name: row.file.name, reason: row.problem! })), ...outcome.skipped]
      setResult(importSummary(outcome.createdIds.length, skipped))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导入失败')
    } finally {
      setBusy(false)
    }
  }
  return <div className="settings-backdrop" role="presentation">
    <section className="settings-dialog create-item-dialog import-dialog" role="dialog" aria-label="导入笔记">
      <div><h2>导入笔记</h2><Button appearance="subtle" onClick={onClose}>{result ? '完成' : '取消'}</Button></div>
      <ul className="import-file-list" aria-label="要导入的文件">
        {rows.map(({ file, problem }) => <li key={file.name} className={problem ? 'skipped' : undefined}>
          <span className="import-file-name">{file.name}</span>
          <span className="import-file-meta">{problem ?? formatSize(file.data.byteLength)}</span>
        </li>)}
      </ul>
      {!result && <>
        <label className="dialog-field"><span>导入到</span>
          <select aria-label="导入到" value={targetKey} onChange={(event) => setTargetKey(event.currentTarget.value)}>
            {targets.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
          </select>
        </label>
        <p className="settings-note">Markdown 保留标题、列表、表格和代码块；.txt 按原样保留换行；网页只保留结构，去掉样式。</p>
      </>}
      {result && <p role="status">{result}</p>}
      {error && <p role="alert">{error}</p>}
      {!result && <Button appearance="primary" disabled={!importable.length || !targetKey || busy} onClick={() => void submit()}>{busy ? '正在导入…' : `导入 ${importable.length} 个文件`}</Button>}
    </section>
  </div>
}
