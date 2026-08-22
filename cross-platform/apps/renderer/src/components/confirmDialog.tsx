import { useEffect, useState } from 'react'
import { Button } from '@fluentui/react-components'

export interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (accepted: boolean) => void
}

// Module-level queue so any component can await a confirmation without prop
// drilling; <ConfirmDialogHost/> is mounted once in the app root. Concurrent
// requests are answered in arrival order.
const queue: ConfirmRequest[] = []
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function settle(accepted: boolean) {
  queue.shift()?.resolve(accepted)
  emit()
}

export function requestConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ ...options, resolve })
    emit()
  })
}

/** Test helper: drain unresolved requests so a failing path cannot leak state. */
export function pendingConfirmRequests(): number {
  return queue.length
}

export function ConfirmDialogHost() {
  const [, setVersion] = useState(0)
  useEffect(() => {
    const listener = () => setVersion((version) => version + 1)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  const request = queue[0]
  useEffect(() => {
    if (!request) return
    // Capture phase: Escape must answer the confirm before other dialogs see it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      settle(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [request])
  if (!request) return null
  return <div className="settings-backdrop" role="presentation" onClick={() => settle(false)}>
    <section
      className="settings-dialog confirm-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-label={request.title}
      onClick={(event) => event.stopPropagation()}
    >
      <h2>{request.title}</h2>
      {request.description && <p className="confirm-dialog-description">{request.description}</p>}
      <div className="confirm-dialog-actions">
        <Button appearance="secondary" onClick={() => settle(false)}>{request.cancelLabel ?? '取消'}</Button>
        <Button
          appearance="primary"
          className={request.destructive ? 'destructive-button' : undefined}
          autoFocus
          onClick={() => settle(true)}
        >
          {request.confirmLabel ?? '确定'}
        </Button>
      </div>
    </section>
  </div>
}
