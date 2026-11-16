// electron-builder afterSign hook. Builds are unsigned (no Apple Developer ID), but Apple Silicon refuses
// to run code with no signature at all, so every Mach-O file in the app gets an ad-hoc signature
// (`codesign --sign -`), inner files first, then the bundle. This does not satisfy Gatekeeper: users still
// open the app through System Settings > Privacy & Security > Open Anyway (see docs/install.md).
const { execFileSync } = require('node:child_process');
const { closeSync, openSync, readdirSync, readSync, statSync } = require('node:fs');
const { join } = require('node:path');

const MAGIC = new Set([0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

function isMachO(file) {
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(4);
    return readSync(fd, b, 0, 4, 0) === 4 && MAGIC.has(b.readUInt32BE(0));
  } finally {
    closeSync(fd);
  }
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && statSync(p).size >= 4) yield p;
  }
}

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resources = join(app, 'Contents', 'Resources');
  let n = 0;
  // Only the files electron-builder did not sign itself: the bundled Node, Temporal and the backend's modules.
  for (const dir of ['node', 'temporal', 'app']) {
    for (const f of walk(join(resources, dir))) {
      if (!isMachO(f)) continue;
      execFileSync('codesign', ['--force', '--sign', '-', f], { stdio: 'inherit' });
      n++;
    }
  }
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed ${n} bundled binaries and ${app}`);
};
