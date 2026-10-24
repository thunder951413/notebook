import { deflateSync } from 'node:zlib'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const output = join(root, 'renderer/public')

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSquared = dx * dx + dy * dy
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

// Signed distance to a rounded square centred at (c, c) with half-size h and corner radius r.
function distanceToRoundedSquare(px, py, c, h, r) {
  const qx = Math.abs(px - c) - h + r
  const qy = Math.abs(py - c) - h + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

// The app icon in one colour, drawn in an 18pt box: a 14pt rounded square with
// the round-capped N cut out of it, so it sits at the weight of system glyphs.
function covered(x, y) {
  const strokes = [
    [6.3, 12.3, 6.3, 5.7],
    [6.3, 5.7, 11.7, 12.3],
    [11.7, 12.3, 11.7, 5.7],
  ]
  if (strokes.some(([x1, y1, x2, y2]) => distanceToSegment(x, y, x1, y1, x2, y2) <= 0.85)) return false
  return distanceToRoundedSquare(x, y, 9, 7, 3.3) <= 0
}

function createTemplatePng(size) {
  const samples = 5
  const rows = []
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4)
    row[0] = 0
    for (let x = 0; x < size; x += 1) {
      let hits = 0
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = (x + (sx + 0.5) / samples) * 18 / size
          const py = (y + (sy + 0.5) / samples) * 18 / size
          if (covered(px, py)) hits += 1
        }
      }
      const offset = 1 + x * 4
      row[offset] = 0
      row[offset + 1] = 0
      row[offset + 2] = 0
      row[offset + 3] = Math.round(255 * hits / (samples * samples))
    }
    rows.push(row)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND'),
  ])
}

await Promise.all([
  writeFile(join(output, 'notebook-trayTemplate.png'), createTemplatePng(18)),
  writeFile(join(output, 'notebook-trayTemplate@2x.png'), createTemplatePng(36)),
])
