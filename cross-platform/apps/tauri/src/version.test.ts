// @vitest-environment node
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('the three version declarations agree, so a local build never regresses the updater', () => {
  const pkg = (JSON.parse(read('package.json')) as { version: string }).version
  const conf = (JSON.parse(read('src-tauri/tauri.conf.json')) as { version: string }).version
  const cargo = /^version = "([^"]+)"/m.exec(read('src-tauri/Cargo.toml'))?.[1]
  const lock = /name = "notebook"\nversion = "([^"]+)"/.exec(read('src-tauri/Cargo.lock'))?.[1]
  expect({ conf, cargo, lock }).toEqual({ conf: pkg, cargo: pkg, lock: pkg })
})
