// Shared server helpers: ids, hashing, JSON, zip (store-only), misc.
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const uuid = () => crypto.randomUUID();

export const isoNow = () => new Date().toISOString();

export function nextIso(previous) {
  const now = Date.now();
  const prior = new Date(previous || 0).getTime();
  return new Date(Math.max(now, Number.isFinite(prior) ? prior + 1 : now)).toISOString();
}

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

export function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

export function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function timingSafeEqualHex(a, b) {
  const ab = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// ---------- body parsing ----------

export async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      const err = new Error('body too large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    const err = new Error('invalid JSON body');
    err.status = 400;
    throw err;
  }
}

// ---------- zip: small interoperable STORE writer + STORE/DEFLATE reader ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a zip archive (STORE, no compression) from [{name, data:Buffer}]. */
export function buildZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0x0800, 6);   // UTF-8 names
    local.writeUInt16LE(0, 8);        // method: store
    local.writeUInt16LE(0, 10);       // time
    local.writeUInt16LE(0x21, 12);    // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const centralOffset = offset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, ...central, end]);
}

/** Read a standard STORE/DEFLATE zip buffer -> Map(name -> Buffer). */
export function readZip(buf, { maxEntries = 50_000, maxEntrySize = 256 * 1024 * 1024, maxTotalSize = 512 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const bad = (message = 'corrupt zip') => {
    const err = new Error(message);
    err.status = 400;
    return err;
  };
  let eocd = -1;
  const min = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0 || eocd + 22 > buf.length) throw bad();
  const disk = buf.readUInt16LE(eocd + 4);
  const centralDisk = buf.readUInt16LE(eocd + 6);
  const diskEntries = buf.readUInt16LE(eocd + 8);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  const commentLen = buf.readUInt16LE(eocd + 20);
  if (disk || centralDisk || diskEntries !== entryCount) throw bad('multi-disk zip is not supported');
  if (entryCount > maxEntries) throw bad('zip has too many entries');
  if (eocd + 22 + commentLen > buf.length || centralOffset + centralSize > eocd) throw bad();

  const out = new Map();
  let totalSize = 0;
  let pos = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (pos + 46 > eocd || buf.readUInt32LE(pos) !== 0x02014b50) throw bad();
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const expectedCrc = buf.readUInt32LE(pos + 16);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const entryCommentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const next = pos + 46 + nameLen + extraLen + entryCommentLen;
    if (next > eocd || localOffset + 30 > centralOffset) throw bad();
    if (flags & 0x0001) throw bad('encrypted zip entries are not supported');
    if (method !== 0 && method !== 8) throw bad('zip entry uses unsupported compression');
    if (uncompressedSize > maxEntrySize || totalSize + uncompressedSize > maxTotalSize) throw bad('zip expands beyond the allowed size');
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    if (name.includes('\0') || name.startsWith('/') || name.split('/').some(part => part === '..')) throw bad('unsafe zip entry name');
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw bad();
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset) throw bad();
    const compressed = buf.subarray(dataStart, dataEnd);
    let data;
    try {
      data = method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed, { maxOutputLength: maxEntrySize });
    } catch {
      throw bad('invalid deflate data');
    }
    if (data.length !== uncompressedSize || crc32(data) !== expectedCrc) throw bad('zip entry checksum mismatch');
    totalSize += data.length;
    if (!name.endsWith('/')) {
      if (out.has(name)) throw bad('zip contains duplicate entry names');
      out.set(name, data);
    }
    pos = next;
  }
  if (pos !== centralOffset + centralSize) throw bad();
  return out;
}

// ---------- misc ----------

export function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function safeName(s) {
  return String(s).replace(/[\u0000-\u001f\u007f\\\/:*?"<>|]/g, '_').slice(0, 120) || 'untitled';
}

export function contentDisposition(filename) {
  const clean = [...safeName(filename)].map(char => {
    const point = char.codePointAt(0);
    return point >= 0xd800 && point <= 0xdfff ? '\ufffd' : char;
  }).join('');
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 ? clean.slice(dot).replace(/[^.A-Za-z0-9_-]/g, '') : '';
  const stem = (dot > 0 ? clean.slice(0, dot) : clean)
    .normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\;]/g, '_').trim() || 'download';
  const fallback = (stem.slice(0, Math.max(1, 120 - ext.length)) + ext).replace(/%/g, '_');
  const encoded = encodeURIComponent(clean).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function stripMarkdown(s) {
  return String(s)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_~`>|]/g, '')
    .replace(/\[[ x]\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}
