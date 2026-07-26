export interface DesktopAIChatRequest {
  requestId: string
  provider: 'openai' | 'deepseek' | 'custom'
  baseUrl: string
  model: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
}

export interface DesktopAIChatResponse {
  content: string
  model?: string
  usage?: { promptTokens?: number; completionTokens?: number }
}
