import type { ReactElement } from 'react'

export function RailButton({ label, selected, pressed = selected, icon, onClick }: { label: string; selected: boolean; pressed?: boolean; icon: ReactElement; onClick: () => void }) {
  return <button className={`rail-button ${selected ? 'selected' : ''}`} aria-label={label} aria-pressed={pressed} title={label} onClick={onClick}>{icon}</button>
}
