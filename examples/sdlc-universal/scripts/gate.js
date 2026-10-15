// The language-neutral test gate of sdlc-universal. A workspace test command is a string of at most
// 1000 characters run in the checkout, so workflow.yaml carries this file compressed
// (build_gate_commands.mjs prints the two commands). `node -e <this> full` runs install, typecheck and
// tests; `node -e <this> static` runs install, typecheck and build (used when the tests cannot run here).
//
// Commands come from, highest first: .azhi/commands.json in the repository
// ({"install","typecheck","test","build"}), then detection: package.json scripts (npm, pnpm or yarn
// by lockfile), Cargo.toml, go.mod, Python (pytest). Any other stack (Maven, Gradle, .NET...) states its
// commands in .azhi/commands.json. Nothing is guessed beyond that:
// a gate with no usable command exits 1 and says why.
const cp = require('child_process');
const fs = require('fs');
const has = (f) => fs.existsSync(f);
const read = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const mode = process.argv[1] === 'static' ? 'static' : 'full';
const pkg = read('package.json');
const s = (pkg && pkg.scripts) || {};
const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
let d = {};
if (pkg) d = { install: pm === 'npm' ? (has('package-lock.json') ? 'npm ci' : 'npm i') : pm + ' install', typecheck: s.typecheck ? pm + ' run typecheck' : has('tsconfig.json') ? 'npx tsc --noEmit' : '', test: s.test ? pm + ' test' : '', build: s.build ? pm + ' run build' : '' };
else if (has('Cargo.toml')) d = { typecheck: 'cargo check', test: 'cargo test', build: 'cargo build' };
else if (has('go.mod')) d = { typecheck: 'go vet ./...', test: 'go test ./...', build: 'go build ./...' };
else if (has('pyproject.toml') || has('requirements.txt')) d = { install: has('requirements.txt') ? 'pip install -r requirements.txt' : 'pip install -e .', test: 'python -m pytest -q' };
const k = Object.assign(d, read('.azhi/commands.json'));
const steps = mode === 'static' ? ['install', 'typecheck', 'build'] : ['install', 'typecheck', 'test'];
if (mode === 'full' ? !k.test : !k.typecheck && !k.build) {
  console.log('no ' + mode + ' command; see .azhi/commands.json');
  process.exit(1);
}
for (const x of steps)
  if (k[x]) {
    try {
      cp.execSync(k[x], { stdio: 'inherit' });
    } catch {
      process.exit(1);
    }
  }
