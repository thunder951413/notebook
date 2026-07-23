import { cloneElement, Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface TriggerProps {
  onClick?: (event: ReactMouseEvent<HTMLElement>) => void
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void
  onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void
}

interface ActionMenuProps {
  label: string
  trigger: ReactElement<TriggerProps>
  openOnContext?: boolean
  children: ReactNode
}

export function ActionMenu({ label, trigger, openOnContext = false, children }: ActionMenuProps) {
  const root = useRef<HTMLSpanElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number }>()
  const open = position !== undefined

  const place = (left: number, top: number) => setPosition({ left: Math.max(8, left), top: Math.max(8, top) })

  useLayoutEffect(() => {
    if (!position || !popover.current) return
    const bounds = popover.current.getBoundingClientRect()
    const left = Math.max(8, Math.min(position.left, window.innerWidth - bounds.width - 8))
    const top = Math.max(8, Math.min(position.top, window.innerHeight - bounds.height - 8))
    if (left !== position.left || top !== position.top) setPosition({ left, top })
  }, [position])

  useEffect(() => {
    if (!open) return
    const close = () => setPosition(undefined)
    const handlePointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (!root.current?.contains(target) && !popover.current?.contains(target)) close()
    }
    const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close() } }
    window.addEventListener('pointerdown', handlePointer, true)
    window.addEventListener('keydown', handleKey, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    window.addEventListener('scroll', close, true)
    requestAnimationFrame(() => popover.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus())
    return () => {
      window.removeEventListener('pointerdown', handlePointer, true)
      window.removeEventListener('keydown', handleKey, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  const triggerNode = cloneElement(trigger, {
    'aria-expanded': open,
    'aria-haspopup': 'dialog',
    onClick: (event: ReactMouseEvent<HTMLElement>) => {
      trigger.props.onClick?.(event)
      if (!openOnContext) {
        const rect = event.currentTarget.getBoundingClientRect()
        open ? setPosition(undefined) : place(rect.left, rect.bottom + 4)
      }
    },
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
      trigger.props.onContextMenu?.(event)
      if (!openOnContext) return
      event.preventDefault()
      place(event.clientX, event.clientY)
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      trigger.props.onKeyDown?.(event)
      if (!openOnContext || !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      place(rect.left + 16, rect.bottom + 4)
    },
  } as TriggerProps)

  const floatingMenu = open && createPortal(<div ref={popover} className="action-menu-popover" role="dialog" aria-modal="false" aria-label={label} style={position} onClick={(event) => {
      const action = (event.target as HTMLElement).closest('button:not(:disabled)')
      if (action) queueMicrotask(() => setPosition(undefined))
    }}>{children}</div>, document.querySelector<HTMLElement>('.app-shell') ?? document.body)

  return <Fragment><span ref={root} className="action-menu-root">{triggerNode}</span>{floatingMenu}</Fragment>
}

export function ActionMenuDivider() {
  return <span className="action-menu-divider" aria-hidden="true" />
}
