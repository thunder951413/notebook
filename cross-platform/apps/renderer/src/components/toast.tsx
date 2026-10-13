import { useEffect, useState } from 'react'

export interface ToastOptions {
  kind?: 'info' | 'error'
  durationMs?: number
  /** One inline action, e.g. 撤销 after moving a note to the trash. */
  action?: { label: string; run: () => void }
}

export interface ToastEntry {
  id: number
  message: string
  kind: 'info' | 'error'
  action?: { label: string; run: () => void }
}

const DEFAULT_DURATION_MS = 4_000

let entries: ToastEntry[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function showToast(message: string, options: ToastOptions = {}) {
  if (!message) return
  const entry: ToastEntry = { id: nextId++, message, kind: options.kind ?? 'info', ...(options.action ? { action: options.action } : {}) }
  entries = [...entries, entry]
  emit()
  window.setTimeout(() => dismissToast(entry.id), Math.max(1_000, options.durationMs ?? DEFAULT_DURATION_MS))
}

export function dismissToast(id: number) {
  if (!entries.some((entry) => entry.id === id)) return
  entries = entries.filter((entry) => entry.id !== id)
  emit()
}

export function getToasts(): ToastEntry[] {
  return entries
}

/** Operation feedback that used to be invisible outside the settings dialog. */
export function ToastHost() {
  const [toasts, setToasts] = useState(entries)
  useEffect(() => {
    const listener = () => setToasts([...entries])
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  if (!toasts.length) return null
  return <div className="toast-stack" role="status" aria-live="polite">
    {toasts.map((toast) => (
      <div key={toast.id} className={`toast ${toast.kind === 'error' ? 'error' : ''}`}>
        <span>{toast.message}</span>
        {toast.action && <button type="button" className="toast-action" onClick={() => { dismissToast(toast.id); toast.action?.run() }}>{toast.action.label}</button>}
        <button type="button" aria-label="关闭提醒" onClick={() => dismissToast(toast.id)}>×</button>
      </div>
    ))}
  </div>
}
