import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const BOOTSTRAP_FILE = 'data-root.json'

export interface DataRootSelection {
  path: string
  source: 'default' | 'environment' | 'command-line' | 'saved'
}

function validatedPath(value: string, source: DataRootSelection['source']): DataRootSelection {
  const input = value.trim()
  if (!input || !isAbsolute(input)) throw new Error(`Notebook data directory from ${source} must be an absolute path`)
  const path = resolve(input)
  if (existsSync(join(path, 'Database', 'notebook.store')) || existsSync(join(path, 'NotebookData', 'Database', 'notebook.store'))) {
    throw new Error('The selected directory contains a legacy SwiftData database and cannot be used as Notebook Next userData')
  }
  return { path, source }
}

export function resolveDataRoot(defaultPath: string, argv = process.argv, environment = process.env): DataRootSelection {
  const argument = argv.find((value) => value.startsWith('--data-dir='))?.slice('--data-dir='.length)
  if (argument) return validatedPath(argument, 'command-line')
  if (environment.NOTEBOOK_NEXT_DATA_DIR) return validatedPath(environment.NOTEBOOK_NEXT_DATA_DIR, 'environment')
  const bootstrapPath = join(defaultPath, BOOTSTRAP_FILE)
  if (existsSync(bootstrapPath)) {
    const saved = JSON.parse(readFileSync(bootstrapPath, 'utf8')) as { path?: string }
    if (saved.path) return validatedPath(saved.path, 'saved')
  }
  return validatedPath(defaultPath, 'default')
}

export function saveDataRoot(defaultPath: string, path: string) {
  const selection = validatedPath(path, 'saved')
  const bootstrapPath = join(defaultPath, BOOTSTRAP_FILE)
  mkdirSync(dirname(bootstrapPath), { recursive: true })
  writeFileSync(bootstrapPath, JSON.stringify({ path: selection.path }, null, 2), { mode: 0o600 })
  return selection.path
}
