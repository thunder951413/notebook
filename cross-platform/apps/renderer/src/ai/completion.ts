import { readAIProviderSettings } from './providerSettings'

export type CompletionMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export const AI_NOT_CONFIGURED = 'AI_NOT_CONFIGURED'

export function aiConfigured() {
  return readAIProviderSettings().enabled && Boolean(window.notebookDesktop?.ai)
}

/** One chat completion through the desktop bridge (the key never reaches the page). */
export async function completeAI(messages: CompletionMessage[], signal: AbortSignal): Promise<string> {
  const provider = readAIProviderSettings()
  const ai = window.notebookDesktop?.ai
  if (!provider.enabled || !ai) throw new Error(AI_NOT_CONFIGURED)
  signal.throwIfAborted()
  const requestId = crypto.randomUUID()
  const cancel = () => { void ai.cancel(requestId) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const result = await ai.complete({ requestId, provider: provider.provider, baseUrl: provider.baseUrl, model: provider.model, messages })
    signal.throwIfAborted()
    return result.content
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
