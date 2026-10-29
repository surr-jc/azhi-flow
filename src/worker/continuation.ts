import { ApplicationFailure } from '@temporalio/common';
import { lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ErrorClass } from '../lib/errors.js';

/**
 * Workspace continuation: a step starts from an earlier step's change. The change is data written by
 * an agent (untrusted), so every path is checked before a file is written, and nothing is written
 * outside the checkout. The worker applies it on top of the change's own base commit.
 */
export interface ContinuationFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  mode: '100644' | '100755';
  content?: string;
  encoding?: 'utf-8' | 'base64';
}

export interface Continuation {
  /** The commit the earlier change was made against; the worker checks this out. */
  baseSha: string;
  files: ContinuationFile[];
}

/** What a step may hand on; the same ceiling `collectChange` enforces when it is collected. */
const LIMITS = { files: 300, contentBytes: 1_000_000 };
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function invalid(message: string) {
  return ApplicationFailure.create({ type: ErrorClass.invalidInput, message, nonRetryable: true });
}

/** Why a path may not be written in a checkout on any platform, or undefined when it is fine. */
export function unsafePath(path: unknown): string | undefined {
  if (typeof path !== 'string' || path === '') return 'is empty';
  if (path.length > 1024) return 'is longer than 1024 characters';
  if (path.includes('\0')) return 'contains a NUL byte';
  if (/[\x00-\x1f]/.test(path)) return 'contains a control character';
  if (path.includes('\\')) return 'contains a backslash';
  if (path.startsWith('/')) return 'is absolute';
  for (const seg of path.split('/')) {
    if (seg === '') return 'has an empty segment';
    if (seg === '.' || seg === '..') return `has a '${seg}' segment`;
    if (/^\.git$/i.test(seg) || /^git~\d+$/i.test(seg)) return 'goes into git metadata';
    if (seg.includes(':')) return "has a ':' in a segment (a drive letter or an alternate data stream on Windows)";
    if (/[. ]$/.test(seg)) return 'has a segment ending in a dot or a space (Windows drops it)';
    if (RESERVED.test(seg.split('.')[0]!)) return `has the reserved Windows name '${seg}'`;
  }
  return undefined;
}

/**
 * Checks the whole change before anything is written: shape, paths, case-insensitive collisions
 * (including a file that is also a folder), and the size ceiling. Throws a non-retryable
 * `invalid_input`, naming the path.
 */
export function validateContinuation(c: Continuation): void {
  if (!SHA.test(c.baseSha)) throw invalid(`continuation base_sha '${String(c.baseSha).slice(0, 80)}' is not a full commit SHA`);
  if (!Array.isArray(c.files)) throw invalid('continuation files must be a list');
  if (c.files.length > LIMITS.files) throw invalid(`the change to continue from has ${c.files.length} files; a step may hand on at most ${LIMITS.files}`);
  const seen = new Map<string, string>();
  let bytes = 0;
  for (const f of c.files) {
    const bad = unsafePath(f?.path);
    if (bad) throw invalid(`the change to continue from has a path '${String(f?.path).slice(0, 200)}' that ${bad}`);
    if (f.status !== 'added' && f.status !== 'modified' && f.status !== 'deleted') throw invalid(`'${f.path}' has status '${String(f.status)}'`);
    if (f.mode !== '100644' && f.mode !== '100755') throw invalid(`'${f.path}' has mode '${String(f.mode)}'; only regular files are handed on`);
    const key = f.path.toLowerCase();
    if (seen.has(key)) throw invalid(`'${f.path}' and '${seen.get(key)}' are the same path on a case-insensitive file system`);
    seen.set(key, f.path);
    if (f.status === 'deleted') continue;
    if (typeof f.content !== 'string') throw invalid(`'${f.path}' has no content to write`);
    if (f.encoding !== undefined && f.encoding !== 'utf-8' && f.encoding !== 'base64') throw invalid(`'${f.path}' has encoding '${String(f.encoding)}'`);
    bytes += f.encoding === 'base64' ? Buffer.from(f.content, 'base64').length : Buffer.byteLength(f.content, 'utf8');
    if (bytes > LIMITS.contentBytes) throw invalid(`the change to continue from is larger than a step may hand on (${LIMITS.contentBytes} bytes of content)`);
  }
  // A file cannot also be a folder that holds another file of the change.
  for (const key of seen.keys()) {
    for (let i = key.indexOf('/'); i >= 0; i = key.indexOf('/', i + 1)) {
      const parent = key.slice(0, i);
      if (seen.has(parent)) throw invalid(`'${seen.get(parent)}' is both a file and a folder of '${seen.get(key)}'`);
    }
  }
}

/** Fails when `rel` or any folder above it inside `dir` is a symbolic link or, for a folder, not a folder. */
function checkParents(dir: string, rel: string) {
  const parts = rel.split('/');
  let cur = dir;
  for (const p of parts.slice(0, -1)) {
    cur = join(cur, p);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return; // not there yet: mkdir creates it, and every level below it is new
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw invalid(`'${rel}': '${p}' in the checkout is a ${st.isSymbolicLink() ? 'symbolic link' : 'file'}, not a folder`);
  }
}

/** Applies a validated change to the checkout in `dir`: added and modified files are written, deleted ones removed. */
export function applyContinuation(dir: string, files: ContinuationFile[]): void {
  for (const f of files) {
    checkParents(dir, f.path);
    const target = join(dir, ...f.path.split('/'));
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(target);
    } catch {
      st = undefined;
    }
    if (st && (st.isDirectory() || st.isSymbolicLink())) throw invalid(`'${f.path}' is a ${st.isDirectory() ? 'folder' : 'symbolic link'} in the checkout, not a file`);
    const exists = st !== undefined;
    if (f.status === 'deleted') {
      if (!exists) throw invalid(`the change deletes '${f.path}', which is not in the base commit; the change does not match its base_sha`);
      unlinkSync(target);
      continue;
    }
    if (f.status === 'added' && exists) throw invalid(`the change adds '${f.path}', which is already in the base commit; the change does not match its base_sha`);
    if (f.status === 'modified' && !exists) throw invalid(`the change modifies '${f.path}', which is not in the base commit; the change does not match its base_sha`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.encoding === 'base64' ? Buffer.from(f.content!, 'base64') : Buffer.from(f.content!, 'utf8'));
  }
}
