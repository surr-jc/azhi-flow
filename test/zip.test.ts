import { describe, expect, it } from 'vitest';
import { readZip, safeEntryPath, writeZip } from '../src/lib/zip.js';

describe('zip', () => {
  it('round-trips text, binary and empty files, compressed or stored', () => {
    const files = new Map<string, Buffer>([
      ['a/b.txt', Buffer.from('hello '.repeat(500))],
      ['bin.dat', Buffer.from([0, 1, 2, 255, 254, 3])],
      ['empty', Buffer.alloc(0)],
      ['ü/名前.md', Buffer.from('unicode path')],
    ]);
    const out = readZip(writeZip(files));
    expect([...out.keys()].sort()).toEqual([...files.keys()].sort());
    for (const [k, v] of files) expect(out.get(k)!.equals(v)).toBe(true);
  });

  it('is deterministic for the same content', () => {
    const files = new Map([['x', Buffer.from('1')], ['a', Buffer.from('2')]]);
    expect(writeZip(files).equals(writeZip(new Map([...files].reverse())))).toBe(true);
  });

  it('rejects unsafe paths, damage and limits', () => {
    for (const p of ['../x', '/abs', 'a/../b', 'a\\b', 'C:/x', 'a//b', './a']) expect(safeEntryPath(p)).toBe(false);
    expect(() => readZip(writeZip(new Map([['../x', Buffer.from('1')]])))).toThrow(/unsafe path/);
    expect(() => readZip(Buffer.from('nope'))).toThrow(/not a zip/);
    const zip = writeZip(new Map([['f', Buffer.from('some content here')]]));
    zip[40] = zip[40]! ^ 0xff; // flip a byte of the stored data
    expect(() => readZip(zip)).toThrow(/checksum|does not unpack/);
    expect(() => readZip(writeZip(new Map([['f', Buffer.alloc(100)]])), { maxEntries: 10, maxFileBytes: 50, maxTotalBytes: 1000 })).toThrow(/larger than/);
    expect(() => readZip(writeZip(new Map([['a', Buffer.from('1')], ['b', Buffer.from('1')]])), { maxEntries: 1, maxFileBytes: 50, maxTotalBytes: 1000 })).toThrow(/more than/);
  });
});
