import { Component, StrictMode, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { FluentProvider } from '@fluentui/react-components'
import { App } from './App'
import { accentCssVariables, loadAccentColor, notebookFluentTheme, saveAccentColor, type AccentColor } from './appearance/accent'
import { loadThemePreference, resolveTheme, type ThemePreference } from './appearance/theme'
import { flushPendingEdits } from './data/flushCoordinator'
import { recordDiagnosticEvent } from './diagnostics/diagnostics'
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
    // Keep only bundle file names with line:column so the frames can be
    // mapped back to source; the error text itself may contain note content.
    const frames = (text: string | null | undefined) => (text ?? '').split('\n')
      .map((line) => line.replace(/\S*\/(assets\/[^\s/)]+)/g, '$1').trim())
      .filter(Boolean)
    recordDiagnosticEvent({
      level: 'error', category: 'app', action: 'render-crash', status: 'failed',
      errorType: error.name,
      stack: [...frames(error.stack).slice(0, 3), ...frames(info.componentStack).slice(0, 2)],
    })
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
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => loadThemePreference())
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const theme = resolveTheme(themePreference, systemDark)
  const [accentColor, setAccentColor] = useState<AccentColor>(() => loadAccentColor())
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('notebook-theme', themePreference) }, [theme, themePreference])
  useEffect(() => {
    document.documentElement.dataset.accent = accentColor
    for (const [name, value] of Object.entries(accentCssVariables(accentColor))) {
      if (typeof value === 'string' || typeof value === 'number') document.documentElement.style.setProperty(name, String(value))
    }
    saveAccentColor(accentColor)
  }, [accentColor])
  useEffect(() => {
    void navigator.storage?.persist?.().catch(() => false)
    return window.notebookDesktop?.events.onFlushRequested(flushPendingEdits)
  }, [])
  return (
    <StrictMode>
      <FluentProvider theme={notebookFluentTheme(theme, accentColor)} style={accentCssVariables(accentColor)} className={`fluent-root theme-${theme}`}>
        <App theme={theme} themePreference={themePreference} accentColor={accentColor} onAccentColorChange={setAccentColor} onThemePreferenceChange={setThemePreference} />
      </FluentProvider>
    </StrictMode>
  )
}

createRoot(document.getElementById('root')!).render(<AppErrorBoundary><Root /></AppErrorBoundary>)
