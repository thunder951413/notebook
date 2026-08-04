import type { PointerEvent as ReactPointerEvent } from 'react'

export function PanelResizer({ label, value, min, max, resetValue, onChange, side = 'right' }: { label: string; value: number; min: number; max: number; resetValue: number; onChange: (value: number) => void; side?: 'left' | 'right' }) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next))
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startValue = value
    const move = (moveEvent: PointerEvent) => onChange(clamp(startValue + (moveEvent.clientX - startX) * (side === 'left' ? -1 : 1)))
    const stop = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', stop); document.body.classList.remove('resizing-panel') }
    document.body.classList.add('resizing-panel')
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop, { once: true })
  }
  return <div className={`panel-resizer ${side}`} role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} onPointerDown={beginResize} onDoubleClick={() => onChange(resetValue)} onKeyDown={(event) => {
    const direction = side === 'left' ? -1 : 1
    if (event.key === 'ArrowLeft') { event.preventDefault(); onChange(clamp(value - 10 * direction)) }
    if (event.key === 'ArrowRight') { event.preventDefault(); onChange(clamp(value + 10 * direction)) }
    if (event.key === 'Home') { event.preventDefault(); onChange(min) }
    if (event.key === 'End') { event.preventDefault(); onChange(max) }
  }}><span /></div>
}
