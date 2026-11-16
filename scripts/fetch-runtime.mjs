#!/usr/bin/env node
// Downloads the two programs the desktop app ships next to the compiled backend, for THIS machine's
// platform, into desktop/resources: a real Node (the backend runs under it, not under Electron) and
// the Temporal CLI. Both are checked against pinned SHA-256 values. Run `npm run build:app` first.
//   node scripts/fetch-runtime.mjs
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dest = join(root, 'desktop', 'resources');
const win = process.platform === 'win32';

const NODE_VERSION = '22.23.5';
// From https://nodejs.org/dist/v22.23.5/SHASUMS256.txt
const NODE = {
  'win32-x64': { file: `node-v${NODE_VERSION}-win-x64.zip`, sha: '4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3' },
  'darwin-arm64': { file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, sha: 'e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d' },
  'darwin-x64': { file: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, sha: 'c53383238206b9ae4db23c5d8a63645e2e753bec8ab51a49cc81939aa64e9422' },
};

const fail = (m) => {
  console.error(`[fetch-runtime] ${m}`);
  process.exit(1);
};
const log = (m) => console.log(`[fetch-runtime] ${m}`);

const key = `${process.platform}-${process.arch}`;
const pin = NODE[key];
if (!pin) fail(`no Node build is pinned for ${key}; the desktop app targets ${Object.keys(NODE).join(', ')}`);

// 1. Node
const nodeExe = win ? 'node.exe' : 'node';
const nodeDir = join(dest, 'node');
if (existsSync(join(nodeDir, nodeExe)) && existsSync(join(nodeDir, '.version')) && readFileSync(join(nodeDir, '.version'), 'utf8') === `${NODE_VERSION} ${key}`) {
  log(`node ${NODE_VERSION} already in place`);
} else {
  log(`downloading ${pin.file}`);
  const res = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${pin.file}`);
  if (!res.ok) fail(`download failed: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(body).digest('hex');
  if (got !== pin.sha) fail(`checksum mismatch for ${pin.file}: expected ${pin.sha}, got ${got}`);
  const staging = join(dest, '.node-staging');
  rmSync(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, pin.file), body);
  // Windows ships a .zip: `tar` there may be Git's GNU tar, which cannot read zip, so use PowerShell.
  const t = win
    ? spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${pin.file}' -DestinationPath '.' -Force`], { cwd: staging, encoding: 'utf8', windowsHide: true })
    : spawnSync('tar', ['-xzf', pin.file], { cwd: staging, encoding: 'utf8' });
  if (t.status !== 0) fail(`cannot extract ${pin.file}: ${t.stderr || t.error?.message}`);
  const inner = join(staging, pin.file.replace(/\.(zip|tar\.gz)$/, ''));
  rmSync(nodeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  mkdirSync(nodeDir, { recursive: true });
  cpSync(join(inner, win ? 'node.exe' : join('bin', 'node')), join(nodeDir, nodeExe));
  cpSync(join(inner, 'LICENSE'), join(nodeDir, 'LICENSE'));
  if (!win) chmodSync(join(nodeDir, nodeExe), 0o755);
  writeFileSync(join(nodeDir, '.version'), `${NODE_VERSION} ${key}`);
  rmSync(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  log(`node ${NODE_VERSION} ready`);
}

// 2. Temporal CLI: reuse the backend's own pinned, checksum-verified download.
const temporalModule = join(root, 'build', 'app', 'src', 'local', 'temporal.js');
if (!existsSync(temporalModule)) fail('build/app is missing; run npm run build:app first');
const { ensureTemporalCli } = await import(pathToFileURL(temporalModule).href);
const exe = win ? 'temporal.exe' : 'temporal';
// ensureTemporalCli would accept an unverified `temporal` from PATH or AZHI_TEMPORAL_BIN; hide both.
delete process.env.AZHI_TEMPORAL_BIN;
process.env.PATH = (process.env.PATH ?? '').split(delimiter).filter((d) => d && !existsSync(join(d, exe))).join(delimiter);
const cache = join(dest, '.temporal-cache');
const found = await ensureTemporalCli(cache, log);
if (!existsSync(found)) fail(`unexpected Temporal CLI location: ${found}`);
const tdir = join(dest, 'temporal');
mkdirSync(tdir, { recursive: true });
cpSync(found, join(tdir, exe));
if (!win) chmodSync(join(tdir, exe), 0o755);
log(`temporal ready at ${join(tdir, exe)}`);
