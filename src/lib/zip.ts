import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { AzhiError, ErrorClass } from './errors.js';

/**
 * A small zip reader and writer (stored or deflate, no zip64, no encryption), enough for workflow
 * bundles. The reader is for untrusted input: entry count, paths and inflated sizes are checked
 * before any content is used.
 */
export interface ZipLimits { maxEntries: number; maxFileBytes: number; maxTotalBytes: number }
export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 5000, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024 };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Fixed timestamp (1980-01-01) so the same bundle content always produces the same bytes.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export function writeZip(files: Map<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, data] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const name = Buffer.from(path, 'utf8');
    const deflated = deflateRawSync(data);
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(DOS_TIME, 12);
    cen.writeUInt16LE(DOS_DATE, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const bad = (why: string) => new AzhiError(ErrorClass.invalidInput, `not a readable bundle: ${why}`);

/** A path that stays inside the archive: relative, forward slashes, no `.`/`..` segments. */
export function safeEntryPath(p: string): boolean {
  return Boolean(p) && !p.startsWith('/') && !p.includes('\\') && !p.includes('\0') && !/^[a-zA-Z]:/.test(p) && p.split('/').every((s) => s && s !== '.' && s !== '..');
}

export function readZip(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Map<string, Buffer> {
  // The end-of-central-directory record is in the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad('this is not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (count > limits.maxEntries) throw bad(`more than ${limits.maxEntries} files`);
  const out = new Map<string, Buffer>();
  let total = 0;
  let p = dirOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad('damaged directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue; // directory entry
    if (flags & 1) throw bad(`${name} is encrypted`);
    if (!safeEntryPath(name)) throw bad(`unsafe path '${name}'`);
    if (out.has(name)) throw bad(`'${name}' appears twice`);
    if (usize > limits.maxFileBytes) throw bad(`${name} is larger than ${limits.maxFileBytes} bytes`);
    total += usize;
    if (total > limits.maxTotalBytes) throw bad('the bundle is too large when unpacked');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw bad(`damaged entry ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > buf.length) throw bad(`${name} is cut short`);
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: usize + 1 });
      } catch {
        throw bad(`${name} does not unpack`);
      }
    } else throw bad(`${name} uses an unsupported compression method`);
    if (data.length !== usize || crc32(data) !== crc) throw bad(`${name} is damaged (checksum)`);
    out.set(name, data);
  }
  return out;
}
