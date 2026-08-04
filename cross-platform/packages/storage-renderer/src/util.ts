/** Extracts readable text from a Tiptap JSON tree for previews and search. */
export function extractText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractText).join(' ')
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  return [record.text, record.content].map(extractText).filter(Boolean).join(' ')
}
