import { describe, expect, it } from 'vitest'
import { documentToMarkdown, markdownToDocument } from './extensions'

const roundTrip = (markdown: string) => documentToMarkdown(markdownToDocument(markdown) as never)

describe('Markdown round trip keeps content intact', () => {
  it('escapes a literal pipe inside table cells so the table does not split on reload', () => {
    const once = roundTrip('| a | b |\n| --- | --- |\n| x \\| y | `c|d` |\n')
    expect(once).toContain('x \\| y')
    expect(once).toContain('`c\\|d`')
    expect(roundTrip(once)).toBe(once)
    const table = (markdownToDocument(once) as { content: Array<{ content: Array<{ content: unknown[] }> }> }).content[0]!
    const rows = table.content
    expect(rows.map((row) => row.content.length)).toEqual([2, 2])
  })

  it('fences code that itself contains a ``` fence with a longer fence', () => {
    const source = '````md\n```js\nx\n```\n````\n'
    const once = roundTrip(source)
    expect(once.trim()).toBe(source.trim())
    expect(roundTrip(once)).toBe(once)
  })

  it('keeps plain fenced code blocks on a three-backtick fence', () => {
    expect(roundTrip('```js\nconst a = `x`\n```\n').trim()).toBe('```js\nconst a = `x`\n```')
  })

  it('keeps emoji and astral characters whole', () => {
    expect(roundTrip('😀 emoji and 𠀀 rare\n').trim()).toBe('😀 emoji and 𠀀 rare')
  })
})
