import { closeSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const BOOTSTRAP_FILE = 'data-root.json'
interface DataRootBootstrap { path?: string; pendingMigrationFrom?: string }

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

function writeBootstrap(defaultPath: string, value: DataRootBootstrap) {
  const bootstrapPath = join(defaultPath, BOOTSTRAP_FILE)
  mkdirSync(dirname(bootstrapPath), { recursive: true })
  const temporary = `${bootstrapPath}.${process.pid}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'w', 0o600)
    writeFileSync(descriptor, JSON.stringify(value, null, 2))
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, bootstrapPath)
    try {
      const directory = openSync(dirname(bootstrapPath), 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    } catch {
      // Windows does not allow opening directories for fsync.
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporary, { force: true })
    throw error
  }
}

function migrateDataRoot(source: string, target: string) {
  const ignored = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'Crashpad', 'logs', BOOTSTRAP_FILE])
  mkdirSync(target, { recursive: true })
  for (const name of readdirSync(source)) {
    if (ignored.has(name) || name.startsWith('Singleton')) continue
    const destination = join(target, name)
    if (existsSync(destination)) continue
    cpSync(join(source, name), destination, { recursive: true, errorOnExist: true, force: false })
  }
}

export function resolveDataRoot(defaultPath: string, argv = process.argv, environment = process.env): DataRootSelection {
  const argument = argv.find((value) => value.startsWith('--data-dir='))?.slice('--data-dir='.length)
  if (argument) return validatedPath(argument, 'command-line')
  if (environment.NOTEBOOK_NEXT_DATA_DIR) return validatedPath(environment.NOTEBOOK_NEXT_DATA_DIR, 'environment')
  const bootstrapPath = join(defaultPath, BOOTSTRAP_FILE)
  if (existsSync(bootstrapPath)) {
    const saved = JSON.parse(readFileSync(bootstrapPath, 'utf8')) as DataRootBootstrap
    if (saved.path) {
      const selection = validatedPath(saved.path, 'saved')
      if (saved.pendingMigrationFrom && resolve(saved.pendingMigrationFrom) !== selection.path) {
        migrateDataRoot(resolve(saved.pendingMigrationFrom), selection.path)
        writeBootstrap(defaultPath, { path: selection.path })
      }
      return selection
    }
  }
  return validatedPath(defaultPath, 'default')
}

export function saveDataRoot(defaultPath: string, path: string, migrateFrom?: string) {
  const selection = validatedPath(path, 'saved')
  mkdirSync(selection.path, { recursive: true })
  const source = migrateFrom ? resolve(migrateFrom) : undefined
  if (source && source !== selection.path) {
    const targetInsideSource = relative(source, selection.path)
    const sourceInsideTarget = relative(selection.path, source)
    if ((!targetInsideSource.startsWith('..') && !isAbsolute(targetInsideSource)) || (!sourceInsideTarget.startsWith('..') && !isAbsolute(sourceInsideTarget))) {
      throw new Error('新旧数据目录不能互为父子目录，请选择独立目录')
    }
  }
  const targetIsEmpty = readdirSync(selection.path).length === 0
  writeBootstrap(defaultPath, {
    path: selection.path,
    ...(source && source !== selection.path && targetIsEmpty ? { pendingMigrationFrom: source } : {}),
  })
  return selection.path
}
