import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { resolveDataRoot, saveDataRoot } from './dataRoot'

const roots: string[] = []
const temporary = () => { const value = mkdtempSync(join(tmpdir(), 'notebook-data-root-')); roots.push(value); return value }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

test('uses explicit command-line and environment roots before saved settings', () => {
  const defaultPath = temporary()
  const saved = temporary()
  const environment = temporary()
  const command = temporary()
  saveDataRoot(defaultPath, saved)
  expect(resolveDataRoot(defaultPath, ['electron'], { NOTEBOOK_NEXT_DATA_DIR: environment })).toEqual({ path: environment, source: 'environment' })
  expect(resolveDataRoot(defaultPath, ['electron', `--data-dir=${command}`], { NOTEBOOK_NEXT_DATA_DIR: environment })).toEqual({ path: command, source: 'command-line' })
  expect(resolveDataRoot(defaultPath, ['electron'], {})).toEqual({ path: saved, source: 'saved' })
})

test('rejects relative data roots', () => {
  expect(() => resolveDataRoot(temporary(), ['electron', '--data-dir=relative'], {})).toThrow(/absolute/)
})

test('rejects a legacy NotebookData directory', () => {
  const defaultPath = temporary()
  const legacy = temporary()
  mkdirSync(join(legacy, 'NotebookData', 'Database'), { recursive: true })
  writeFileSync(join(legacy, 'NotebookData', 'Database', 'notebook.store'), '')
  expect(() => resolveDataRoot(defaultPath, ['electron', `--data-dir=${legacy}`], {})).toThrow(/legacy SwiftData/)
})
