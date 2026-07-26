import { useEffect, useState } from 'react'
import { Button, Input, Select, Switch, Text } from '@fluentui/react-components'
import {
  AI_PROVIDER_PRESETS,
  readAIProviderSettings,
  saveAIProviderSettings,
  type AIProviderKind,
  type AIProviderSettings,
} from '../ai/providerSettings'

export function AIProviderSettingsPanel() {
  const [settings, setSettings] = useState<AIProviderSettings>(() => readAIProviderSettings())
  const [apiKey, setApiKey] = useState('')
  const [storedKeyFor, setStoredKeyFor] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const desktop = Boolean(window.notebookDesktop?.ai)
  const keyIdentity = `${settings.provider}:${settings.baseUrl}`
  const storedKey = storedKeyFor === keyIdentity

  useEffect(() => {
    if (!desktop) return
    setStoredKeyFor(undefined)
    setApiKey('')
    let valid = false
    try { valid = new URL(settings.baseUrl).protocol === 'https:' } catch { valid = false }
    if (!valid) return
    void window.notebookDesktop?.ai.hasKey(settings.provider, settings.baseUrl)
      .then((value) => setStoredKeyFor(value ? `${settings.provider}:${settings.baseUrl}` : undefined))
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : '无法读取 AI 密钥状态'))
  }, [desktop, settings.baseUrl, settings.provider])

  const chooseProvider = (provider: AIProviderKind) => {
    setSettings((current) => ({
      ...current,
      provider,
      ...(provider === 'custom' ? {} : AI_PROVIDER_PRESETS[provider]),
    }))
  }

  const persist = async (test: boolean) => {
    if (!window.notebookDesktop?.ai || busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      if ((settings.enabled || test) && !storedKey && !apiKey.trim()) throw new Error('请先填写此服务商的 API Key')
      const normalized = saveAIProviderSettings(settings)
      if (apiKey.trim()) {
        await window.notebookDesktop.ai.setKey(normalized.provider, normalized.baseUrl, apiKey.trim())
        setApiKey('')
        setStoredKeyFor(`${normalized.provider}:${normalized.baseUrl}`)
      }
      setSettings(normalized)
      if (test) {
        const result = await window.notebookDesktop.ai.complete({
          requestId: crypto.randomUUID(),
          provider: normalized.provider,
          baseUrl: normalized.baseUrl,
          model: normalized.model,
          messages: [
            { role: 'system', content: '这是 Notebook 的连接测试。' },
            { role: 'user', content: '只回复 OK' },
          ],
        })
        setMessage(normalized.enabled
          ? `连接成功：${result.model ?? normalized.model}。内置 AI 对话已启用。`
          : `连接成功：${result.model ?? normalized.model}。当前开关仍处于关闭状态；打开后才能在 AI 工作区对话。`)
      } else {
        setMessage(normalized.enabled ? 'AI 配置已保存，Notebook AI 将使用此服务。' : 'AI 配置已保存，但内置模型调用仍处于关闭状态。')
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法保存 AI 配置')
    } finally {
      setBusy(false)
    }
  }

  const removeKey = async () => {
    if (!window.notebookDesktop || busy || !window.confirm('确定删除本机保存的 AI API Key 吗？')) return
    setBusy(true)
    try {
      await window.notebookDesktop.ai.deleteKey(settings.provider, settings.baseUrl)
      setStoredKeyFor(undefined)
      setApiKey('')
      setMessage('本机 AI API Key 已删除。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法删除 AI API Key')
    } finally {
      setBusy(false)
    }
  }

  if (!desktop) return <div className="sync-settings-result error">内置 AI 模型仅在 Electron 桌面版可用。</div>

  return <>
    <div className="settings-row">
      <div><strong>内置 AI 对话</strong><span>关闭时不会把笔记内容发送给模型；打开并保存后才能在 AI 工作区对话</span></div>
      <div><Switch checked={settings.enabled} disabled={busy} onChange={(_, data) => setSettings((current) => ({ ...current, enabled: data.checked }))} label={settings.enabled ? '已启用' : '已关闭'} /></div>
    </div>
    <div className="automation-api-config ai-provider-config">
      <label><span>服务商</span><Select value={settings.provider} disabled={busy} onChange={(_, data) => chooseProvider(data.value as AIProviderKind)}><option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option><option value="custom">OpenAI 兼容服务</option></Select></label>
      <label><span>HTTPS 地址</span><Input value={settings.baseUrl} disabled={busy} onChange={(_, data) => setSettings((current) => ({ ...current, baseUrl: data.value }))} /></label>
      <label><span>模型</span><Input value={settings.model} disabled={busy} onChange={(_, data) => setSettings((current) => ({ ...current, model: data.value }))} /></label>
      <label><span>API Key</span><Input type="password" value={apiKey} placeholder={storedKey ? '已安全保存在本机；留空即不修改' : '请输入 API Key'} disabled={busy} onChange={(_, data) => setApiKey(data.value)} /></label>
    </div>
    <div className="settings-action-grid">
      <Button appearance="primary" disabled={busy} onClick={() => void persist(false)}>保存配置</Button>
      <Button disabled={busy} onClick={() => void persist(true)}>保存并测试连接</Button>
      {storedKey && <Button appearance="subtle" disabled={busy} onClick={() => void removeKey()}>删除 API Key</Button>}
    </div>
    <Text size={200}>API Key 使用操作系统加密凭据保存，不进入 IndexedDB、导出包或 SSH 同步。只有点击发送时，所选 <code>@文章</code> 及其允许展开的引用内容才会传给服务商。</Text>
    {message && <div className="sync-settings-result" role="status">{message}</div>}
  </>
}
