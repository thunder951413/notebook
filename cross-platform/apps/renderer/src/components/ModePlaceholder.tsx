import type { ReactNode } from 'react'
import { Button } from '@fluentui/react-components'

export function ModePlaceholder({ icon, title, description, actionLabel = '开始使用', onAction }: { icon: ReactNode; title: string; description: string; actionLabel?: string; onAction?: () => void }) {
  return <div className="mode-placeholder"><div>{icon}</div><h2>{title}</h2><p>{description}</p>{onAction && <Button appearance="primary" onClick={onAction}>{actionLabel}</Button>}</div>
}
