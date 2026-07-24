import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'

const emptyRect = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  toJSON: () => ({})
} as DOMRect

Object.defineProperty(Range.prototype, 'getClientRects', {
  configurable: true,
  value: () => []
})
Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => emptyRect
})

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, String(value)) },
  }
}

Object.defineProperty(window, 'localStorage', { configurable: true, value: memoryStorage() })
Object.defineProperty(window, 'sessionStorage', { configurable: true, value: memoryStorage() })
