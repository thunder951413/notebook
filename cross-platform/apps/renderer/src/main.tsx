import { Component, StrictMode, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { FluentProvider, webDarkTheme, webLightTheme } from '@fluentui/react-components'
import { App } from './App'
import { flushPendingEdits } from './data/flushCoordinator'
import './styles.css'

document.documentElement.dataset.platform = /Mac/i.test(navigator.platform)
  ? 'mac'
  : /Win/i.test(navigator.platform)
    ? 'windows'
    : 'linux'

class AppErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Notebook renderer failed', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return <main className="app-error-fallback" role="alert">
      <h1>Notebook 无法显示当前界面</h1>
      <p>你的笔记数据没有被删除。可以重新载入界面继续使用。</p>
      <details><summary>错误详情</summary><pre>{this.state.error.message}</pre></details>
      <button onClick={() => location.reload()}>重新载入</button>
    </main>
  }
}

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

createRoot(document.getElementById('root')!).render(<AppErrorBoundary><Root /></AppErrorBoundary>)
