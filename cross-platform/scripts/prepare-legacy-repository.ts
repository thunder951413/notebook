import { readFile, writeFile } from 'node:fs/promises'
import { encodeLegacyRepository } from '../packages/sync-contract/src/exporter.ts'
import { strFromU8, unzipSync, zipSync } from '../apps/web/node_modules/fflate/esm/index.mjs'

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const input = argument('--backup')
  const output = argument('--output')
  if (!input || !output) throw new Error('Usage: prepare-legacy-repository.ts --backup <Notebook Next zip> --output <legacy repository zip>')

  const backup = unzipSync(new Uint8Array(await readFile(input)))
  const root = backup['notebook-next.json']
  if (!root) throw new Error('Notebook Next backup is missing notebook-next.json')
  const payload = JSON.parse(strFromU8(root)) as { schemaVersion?: number; bundle?: Parameters<typeof encodeLegacyRepository>[0] }
  if (payload.schemaVersion !== 1 || !payload.bundle) throw new Error('Unsupported Notebook Next backup')

  const assetContents = new Map<string, Uint8Array>()
  for (const asset of payload.bundle.assets) {
    const bytes = backup[`assets/${asset.id}`]
    if (bytes) assetContents.set(asset.id, bytes)
  }

  const encoded = await encodeLegacyRepository(payload.bundle, assetContents, crypto.randomUUID())
  await writeFile(output, zipSync(Object.fromEntries(encoded.files), { level: 1 }))
  console.log(JSON.stringify({ output, files: encoded.files.size, pages: encoded.pageVersions.size, skippedPages: encoded.skippedPageIds.length, assets: assetContents.size }))
}

void main()
