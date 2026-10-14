import { createHash } from 'node:crypto'

/** Small shared helpers for the legacy SFTP transport. */

export function cacheBuffer<T extends { data: Buffer }>(cache: Map<string, T>, key: string, value: T, maximumBytes: number) {
  cache.delete(key)
  cache.set(key, value)
  let total = 0
  for (const item of cache.values()) total += item.data.byteLength
  while (total > maximumBytes && cache.size > 1) {
    const oldestKey = cache.keys().next().value
    if (!oldestKey) break
    total -= cache.get(oldestKey)!.data.byteLength
    cache.delete(oldestKey)
  }
}

export const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')
export const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export function mapWithConcurrency<T>(values: T[], limit: number, worker: (value: T) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let index = 0
    let active = 0
    let failed = false
    const next = () => {
      if (failed) return
      while (active < limit && index < values.length) {
        const current = index
        index += 1
        active += 1
        void worker(values[current]!).then(() => {
          active -= 1
          next()
        }, (error) => {
          failed = true
          reject(error)
        })
      }
      if (active === 0 && index >= values.length) resolve()
    }
    next()
  })
}

