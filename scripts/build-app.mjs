#!/usr/bin/env node
// Stages a runnable, compiled copy of Azhi Flow in build/app (no tsx, no bundling at start-up).
// It keeps the repository's relative layout, so every `new URL('../../x', import.meta.url)` lookup
// (migrations, examples, docs, bin) resolves the same way it does in a checkout.
//   node scripts/build-app.mjs [--skip-web] [--skip-install]
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'build', 'app');
const args = new Set(process.argv.slice(2));
const win = process.platform === 'win32';

// Same Windows workaround as bin/azhi.js: SWC will not cache its native addon under %LOCALAPPDATA%.
if (win && !process.env.SWC_NATIVE_BINDING_CACHE) {
  process.env.SWC_NATIVE_BINDING_CACHE = join(process.env.AZHI_HOME ?? join(process.env.USERPROFILE ?? '', '.azhi'), 'swc-cache');
}

const step = (m) => console.log(`\n[build:app] ${m}`);
function run(cmd, argv, cwd = root) {
  const r = spawnSync(cmd, argv, { cwd, stdio: 'inherit', shell: win && cmd === 'npm' });
  if (r.status !== 0) {
    console.error(`[build:app] failed: ${cmd} ${argv.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

step('clean');
// Retries: on Windows a virus scanner or a just-exited process can hold files for a moment.
rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
mkdirSync(out, { recursive: true });

step('compile src/ to JavaScript');
run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json']);

if (!args.has('--skip-web')) {
  step('build the web app');
  run(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', join('web', 'vite.config.ts'), '--logLevel', 'error']);
}
if (!existsSync(join(root, 'src', 'web', 'dist', 'index.html'))) {
  console.error('[build:app] src/web/dist is missing; run without --skip-web');
  process.exit(1);
}

step('copy runtime files');
const copy = (rel) => cpSync(join(root, rel), join(out, rel), { recursive: true });
for (const rel of ['bin', 'migrations', 'examples', 'src/web/dist', 'src/builder/skill.md', 'src/assistant/skill.md', 'package.json', 'package-lock.json']) copy(rel);
// The assistant reads a fixed list of top-level docs.
mkdirSync(join(out, 'docs'), { recursive: true });
for (const f of readdirSync(join(root, 'docs'))) if (f.endsWith('.md')) copy(join('docs', f));

step('bundle the interpreter workflow');
// Same module and options the worker uses from source; the result is loaded with `workflowBundle`.
const { register } = await import('tsx/esm/api');
register();
const { interpreterBuildId, WORKFLOWS_PATH } = await import(pathToFileURL(join(root, 'src', 'runtime', 'interpreter.ts')).href);
const { bundleWorkflowCode } = await import('@temporalio/worker');
const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH, ignoreModules: [] });
const runtimeDir = join(out, 'src', 'runtime');
writeFileSync(join(runtimeDir, 'workflow-bundle.js'), code);
const id = interpreterBuildId();
writeFileSync(join(runtimeDir, 'interpreter-build.json'), JSON.stringify({ id }) + '\n');
console.log(`  interpreter build ${id}, bundle ${(code.length / 1024).toFixed(0)} KB`);

if (!args.has('--skip-install')) {
  step('install production dependencies');
  run('npm', ['ci', '--omit=dev'], out);

  // opencode-ai's install step copies the platform's program to opencode-ai/bin/opencode.exe, which is
  // the only path Azhi runs (src/worker/capabilities.ts). The platform packages it came from, including
  // the baseline (no AVX2) variant, are unused copies of about 200 MB each.
  const modules = join(out, 'node_modules');
  if (existsSync(join(modules, 'opencode-ai', 'bin', 'opencode.exe'))) {
    step('prune unused OpenCode platform packages');
    for (const name of readdirSync(modules)) {
      if (/^opencode-(darwin|linux|windows)-/.test(name)) {
        rmSync(join(modules, name), { recursive: true, force: true });
        console.log(`  removed ${name}`);
      }
    }
  }
}

console.log(`\n[build:app] done: ${out}`);
