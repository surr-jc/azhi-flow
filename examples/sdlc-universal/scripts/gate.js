// The language- and layout-neutral test gate of sdlc-universal. A workspace test command is a string, so
// workflow.yaml carries this file compressed (build_gate_commands.mjs prints the commands, and --write puts them
// into workflow.yaml). `node -e <this> full` runs install, typecheck and tests; `node -e <this> static` runs install,
// typecheck and build (used when the tests cannot run here). A third argument, `plan`, only prints what would run.
//
// Which commands run, highest first:
//  1. .azhi/commands.json in the repository. Either {"install","typecheck","test","build"} for the root, or
//     {"projects":[{"dir":"backend","install":..,"typecheck":..,"test":..,"build":..}, ...]} for several projects.
//     Explicit commands are never mixed with detection of other folders.
//  2. Detection. The root and the folders up to two levels below it are looked at (not hidden folders, node_modules,
//     vendor, target, build output). Every project found runs from its own folder, so a repository with a Java backend,
//     two web front ends and a Python service gets all four checked. Detected stacks: node (npm, pnpm, yarn, bun),
//     Maven, Gradle, .NET, Go, Rust, Python (pip, uv, poetry), Ruby, PHP, Elixir, Swift, and make (a `test` target).
// Nothing is guessed beyond that: with no usable command the gate exits 1 and says why. Every project is run and
// reported, and the gate fails if any of them fails. The last line, AZHI_GATE_RESULT, is JSON with one entry per
// project (dir, stack, status, the step that failed), which the workflow reads to say what could and could not be verified.
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const J = path.join;
const win = process.platform === 'win32';
const mode = process.argv[1] === 'static' ? 'static' : 'full';
const read = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const text = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};
const ls = (d) => {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
};
const KEYS = ['install', 'typecheck', 'test', 'build'];
const str = (v) => (typeof v === 'string' ? v : '');
const norm = (p) => ({ dir: str(p.dir) || '.', stack: str(p.stack) || 'configured', install: str(p.install), typecheck: str(p.typecheck), test: str(p.test), build: str(p.build) });
const useful = (p) => !!(p.test || p.typecheck || p.build);

// All the stacks of one folder. `own` means the folder's build tool also covers the folders below it.
function detect(d) {
  const names = ls(d);
  const f = (n) => names.includes(n);
  const any = (re) => names.some((n) => re.test(n));
  const out = [];
  const add = (stack, own, c) => out.push({ dir: d, stack, own, install: '', typecheck: '', test: '', build: '', ...c });
  if (f('package.json')) {
    const pkg = read(J(d, 'package.json')) || {};
    const s = pkg.scripts || {};
    const pm = f('pnpm-lock.yaml') ? 'pnpm' : f('yarn.lock') ? 'yarn' : f('bun.lockb') || f('bun.lock') ? 'bun' : 'npm';
    add('node/' + pm, !!pkg.workspaces, {
      install: pm === 'npm' ? (f('package-lock.json') ? 'npm ci' : 'npm install') : pm + ' install',
      typecheck: s.typecheck ? pm + ' run typecheck' : f('tsconfig.json') ? 'npx tsc --noEmit' : '',
      test: s.test && !/no test specified/.test(s.test) ? pm + ' run test' : '',
      build: s.build ? pm + ' run build' : '',
    });
  }
  if (f('pom.xml')) {
    const m = f('mvnw') ? (win ? 'mvnw.cmd' : './mvnw') : 'mvn';
    add('java/maven', true, { typecheck: m + ' -B -q compile', test: m + ' -B test', build: m + ' -B -q -DskipTests package' });
  }
  if (any(/^build\.gradle(\.kts)?$/)) {
    const g = f('gradlew') ? (win ? 'gradlew.bat' : './gradlew') : 'gradle';
    add('jvm/gradle', true, { typecheck: g + ' classes testClasses', test: g + ' test', build: g + ' assemble' });
  }
  if (any(/\.(sln|csproj|fsproj)$/)) add('dotnet', true, { install: 'dotnet restore', typecheck: 'dotnet build --no-restore', test: 'dotnet test --no-restore' });
  if (f('go.mod')) add('go', true, { typecheck: 'go vet ./...', test: 'go test ./...', build: 'go build ./...' });
  if (f('Cargo.toml')) add('rust', true, { typecheck: 'cargo check', test: 'cargo test', build: 'cargo build' });
  if (any(/^(pyproject\.toml|requirements.*\.txt|setup\.py|setup\.cfg|Pipfile)$/)) {
    const uv = f('uv.lock');
    const po = f('poetry.lock');
    const run = uv ? 'uv run ' : po ? 'poetry run ' : 'python -m ';
    const tested = f('tests') || f('test') || f('pytest.ini') || f('tox.ini') || f('conftest.py') || /\[tool\.pytest/.test(text(J(d, 'pyproject.toml')));
    add('python', false, {
      install: uv ? 'uv sync' : po ? 'poetry install' : f('requirements.txt') ? 'pip install -r requirements.txt' : 'pip install -e .',
      typecheck: (uv ? 'uv run python' : po ? 'poetry run python' : 'python') + ' -m compileall -q -x "venv|node_modules|site-packages" .',
      test: tested ? run + 'pytest -q' : '',
    });
  }
  if (f('Gemfile')) add('ruby', false, { install: 'bundle install', test: f('Rakefile') ? 'bundle exec rake test' : f('spec') ? 'bundle exec rspec' : '' });
  if (f('composer.json')) {
    const c = read(J(d, 'composer.json')) || {};
    add('php', false, { install: 'composer install --no-interaction', test: c.scripts && c.scripts.test ? 'composer test' : any(/^phpunit\.xml(\.dist)?$/) ? 'vendor/bin/phpunit' : '' });
  }
  if (f('mix.exs')) add('elixir', false, { install: 'mix deps.get', typecheck: 'mix compile', test: 'mix test' });
  if (f('Package.swift')) add('swift', true, { typecheck: 'swift build', test: 'swift test' });
  if (!out.length) {
    const mk = text(J(d, f('Makefile') ? 'Makefile' : 'makefile'));
    if (f('Makefile') || f('makefile')) add('make', true, { test: /^test:/m.test(mk) ? 'make test' : '', build: /^build:/m.test(mk) ? 'make build' : '' });
  }
  return out;
}

const skip = /^(node_modules|vendor|target|build|dist|out|bin|obj|venv|env|__pycache__|coverage|site-packages)$/;
function walk(d, depth, into) {
  const found = detect(d).filter(useful);
  into.push(...found);
  if (depth >= 2 || found.some((p) => p.own)) return;
  for (const n of ls(d)) {
    if (n[0] === '.' || skip.test(n)) continue;
    try {
      if (fs.statSync(J(d, n)).isDirectory()) walk(J(d, n), depth + 1, into);
    } catch {
      /* unreadable */
    }
  }
}

const cfg = read(path.join('.azhi', 'commands.json'));
let plan = [];
if (cfg && Array.isArray(cfg.projects)) plan = cfg.projects.filter((p) => p && typeof p === 'object').map(norm);
else if (cfg) {
  const base = detect('.').find(useful) || {};
  const own = {};
  for (const k of KEYS) if (typeof cfg[k] === 'string') own[k] = cfg[k];
  plan = [norm({ ...base, ...own, dir: '.' })];
} else walk('.', 0, plan);
// A configured folder must be inside the checkout.
plan = plan.filter((p) => !path.isAbsolute(p.dir) && !path.relative('.', p.dir).startsWith('..'));

const steps = mode === 'static' ? ['install', 'typecheck', 'build'] : ['install', 'typecheck', 'test'];
const need = mode === 'static' ? ['typecheck', 'build'] : ['test'];
const runnable = plan.filter((p) => steps.slice(1).some((k) => p[k]));
if (process.argv[2] === 'plan') {
  console.log(JSON.stringify({ mode, projects: runnable.map((p) => ({ dir: p.dir, stack: p.stack, commands: steps.filter((k) => p[k]).map((k) => p[k]) })) }, null, 2));
  process.exit(0);
}
if (!plan.some((p) => need.some((k) => p[k]))) {
  console.log('no ' + mode + ' command; see .azhi/commands.json');
  process.exit(1);
}
const failed = [];
const results = [];
for (const p of runnable) {
  console.log('== ' + p.dir + ' (' + p.stack + ') ==');
  const r = { dir: p.dir, stack: p.stack, status: 'passed', step: '' };
  results.push(r);
  for (const k of steps) {
    if (!p[k]) continue;
    console.log('$ ' + p[k]);
    try {
      cp.execSync(p[k], { stdio: 'inherit', cwd: p.dir });
    } catch {
      failed.push(p.dir + ' ' + k);
      r.status = 'failed';
      r.step = k;
      break;
    }
  }
}
console.log('AZHI_GATE_RESULT ' + JSON.stringify({ mode, projects: results }));
console.log('AZHI_GATE ' + mode + ' ' + (failed.length ? 'failed: ' + failed.join(', ') : 'passed') + ' (' + runnable.length + ' project(s))');
process.exit(failed.length ? 1 : 0);
