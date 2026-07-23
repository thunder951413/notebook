import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FluentProvider, webDarkTheme, webLightTheme } from '@fluentui/react-components'
import { App } from './App'
import { flushPendingEdits } from './data/flushCoordinator'
import './styles.css'

function Root() {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('notebook-theme') as 'light' | 'dark' | null) ?? (prefersDark ? 'dark' : 'light'))
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('notebook-theme', theme) }, [theme])
  useEffect(() => {
    void navigator.storage?.persist?.().catch(() => false)
    return window.notebookDesktop?.events.onFlushRequested(flushPendingEdits)
  }, [])
  return (
    <StrictMode>
      <FluentProvider theme={theme === 'dark' ? webDarkTheme : webLightTheme} className={`fluent-root theme-${theme}`}>
        <App theme={theme} onToggleTheme={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')} />
      </FluentProvider>
    </StrictMode>
  )
}

createRoot(document.getElementById('root')!).render(<Root />)
