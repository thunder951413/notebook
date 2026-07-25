export type AIProviderKind = 'openai' | 'deepseek' | 'custom'

export interface AIProviderSettings {
  enabled: boolean
  provider: AIProviderKind
  baseUrl: string
  model: string
}

const STORAGE_KEY = 'notebook-ai-provider-v1'

export const AI_PROVIDER_PRESETS: Record<Exclude<AIProviderKind, 'custom'>, Pick<AIProviderSettings, 'baseUrl' | 'model'>> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
}

export function defaultAIProviderSettings(): AIProviderSettings {
  return { enabled: false, provider: 'openai', ...AI_PROVIDER_PRESETS.openai }
}

export function readAIProviderSettings(): AIProviderSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '') as Partial<AIProviderSettings>
    const provider: AIProviderKind = parsed.provider === 'deepseek' || parsed.provider === 'custom' ? parsed.provider : 'openai'
    return {
      enabled: parsed.enabled === true,
      provider,
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : provider === 'custom' ? '' : AI_PROVIDER_PRESETS[provider].baseUrl,
      model: typeof parsed.model === 'string' ? parsed.model : provider === 'custom' ? '' : AI_PROVIDER_PRESETS[provider].model,
    }
  } catch {
    return defaultAIProviderSettings()
  }
}

export function saveAIProviderSettings(settings: AIProviderSettings) {
  const base = new URL(settings.baseUrl)
  if (base.protocol !== 'https:') throw new Error('AI 服务地址必须使用 HTTPS')
  if (!settings.model.trim()) throw new Error('请填写模型名称')
  const normalized = {
    ...settings,
    baseUrl: base.toString().replace(/\/$/, ''),
    model: settings.model.trim(),
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  return normalized
}
