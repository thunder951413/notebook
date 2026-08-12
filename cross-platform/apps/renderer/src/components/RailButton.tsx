import type { ReactElement, Ref } from 'react'

export function RailButton({ label, selected, pressed = selected, icon, onClick, buttonRef }: { label: string; selected: boolean; pressed?: boolean; icon: ReactElement; onClick: () => void; buttonRef?: Ref<HTMLButtonElement> }) {
  return <button ref={buttonRef} className={`rail-button ${selected ? 'selected' : ''}`} aria-label={label} aria-pressed={pressed} title={label} onClick={onClick}>{icon}</button>
}
