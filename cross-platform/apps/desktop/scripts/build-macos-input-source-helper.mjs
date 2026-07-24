import { chmod, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

if (process.platform !== 'darwin') process.exit(0)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = join(root, 'build')
const output = join(outputDirectory, 'notebook-input-source')
const source = join(root, 'native', 'macos-input-source.c')

await mkdir(outputDirectory, { recursive: true })

await new Promise((resolve, reject) => {
  const compiler = spawn('/usr/bin/clang', [
    '-O2',
    '-framework', 'Carbon',
    source,
    '-o', output,
  ], { stdio: 'inherit' })
  compiler.once('error', reject)
  compiler.once('exit', (code) => {
    if (code === 0) resolve()
    else reject(new Error(`macOS input-source helper build failed with exit code ${code ?? 'unknown'}`))
  })
})

await chmod(output, 0o755)
