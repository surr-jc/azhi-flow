// The "static" verification of the AI-SDLC v2 workflow: used when the whole test suite cannot run in this
// environment. It runs the typecheck and the build, then runs just the test files the agent added or
// changed, so a new test is executed once before a reviewer reads it.
//
// The workflow cannot ship this file (a test command is a string of at most 1000 characters, run in the
// checkout), so workflow.yaml carries it compressed: see build_verify_command.mjs, which prints the command.
// The worker runs it with a bare environment (PATH, HOME, temp folders): no git, so "changed" means the
// file's modification time is well after the checkout's.
//
// Exit code: non-zero if typecheck, build or a NEW test file fails. A failing test in a file that already
// existed is reported but does not block (it may have been failing on the base branch): the marker line
// AZHI_TARGETED_TESTS tells the final step and the reviewers what happened.
const cp = require('child_process');
const fs = require('fs');
const p = require('path');

const run = (cmd, env) => {
  try {
    cp.execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });
    return 0;
  } catch {
    return 1;
  }
};

if (run('npm ci && npm run typecheck && npm run build:web')) process.exit(1);

// Everything in the checkout shares its time: the oldest top-level file is that time, and an agent's edit comes at least a minute later.
const since = Math.min(...fs.readdirSync('.').map((f) => fs.statSync(f)).filter((s) => s.isFile()).map((s) => s.mtimeMs)) + 6e4;
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = p.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name[0] !== '.') walk(f);
    } else if (/\.test\.[jt]sx?$/.test(e.name)) {
      const s = fs.statSync(f);
      // A new file has a creation time after the checkout; an edited one keeps the checkout's.
      if (s.mtimeMs > since) files.push({ f, isNew: s.birthtimeMs > since });
    }
  }
})('.');

// New files must pass; edited ones are reported only. They run apart so a failure is charged to the right group.
const test = (list) => (list.length ? run('npx vitest run ' + list.map((x) => JSON.stringify(x.f)).join(' '), { AZHI_TEST_DATABASE_URL: 'pglite://' }) : 0);
if (files.length) {
  const newFailed = test(files.filter((x) => x.isNew));
  const editedFailed = test(files.filter((x) => !x.isNew));
  console.log('AZHI_TARGETED_TESTS ' + (newFailed || editedFailed ? 'failed' : 'passed') + ' ' + files.length + ' file(s)');
  if (newFailed) process.exit(1);
}
