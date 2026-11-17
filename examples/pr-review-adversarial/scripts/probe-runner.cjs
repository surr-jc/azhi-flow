// Runs the probes the prober agent wrote under .azhi-probes/<id>/ and prints one result line each.
// This is trusted workflow code, not agent output: the agent writes only a manifest and a probe file.
// It is embedded (base64) in workflow.yaml as the workspace test command, so it stays free of imports
// other than require(), and uses no shell syntax. test/pr-review-adversarial.test.ts keeps the two in sync.
//
//   .azhi-probes/P1/probe.json  {"id":"P1","kind":"cli","argv":["node",".azhi-probes/P1/probe.mjs"]}
//
// A probe prints its verdict as the last line of stdout: "REPRODUCED: <what was seen>" when the failure
// happened, or "HELD: <what was seen>" when the code behaved. Anything else is "not_run", with the reason.
// Limits: 10 minutes per probe, 25 minutes in all, at most 5 probes. The exit code is always 0.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = '.azhi-probes';
const PER_PROBE_MS = 10 * 60 * 1000;
const TOTAL_MS = 25 * 60 * 1000;
const MAX_PROBES = 5;
const started = Date.now();
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const emit = (r) => console.log('AZHI_PROBE ' + JSON.stringify(r));

let dirs = [];
try {
  dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
} catch (e) {
  /* no probes were written */
}

let count = 0;
for (const name of dirs.slice(0, MAX_PROBES)) {
  count += 1;
  let m;
  try {
    m = JSON.parse(fs.readFileSync(path.join(ROOT, name, 'probe.json'), 'utf8'));
  } catch (e) {
    emit({ id: name, state: 'not_run', reason: 'probe.json missing or not JSON' });
    continue;
  }
  if (m.id !== name || !Array.isArray(m.argv) || m.argv.length < 1 || m.argv.length > 20 || m.argv.some((a) => typeof a !== 'string')) {
    emit({ id: name, state: 'not_run', reason: 'probe.json needs id equal to its folder and argv as a list of up to 20 strings' });
    continue;
  }
  const left = TOTAL_MS - (Date.now() - started);
  if (left <= 0) {
    emit({ id: name, state: 'not_run', reason: 'over the 25 minute budget' });
    continue;
  }
  const r = spawnSync(m.argv[0], m.argv.slice(1), {
    cwd: process.cwd(),
    shell: false,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: Math.min(PER_PROBE_MS, left),
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    env: { ...process.env, AZHI_PROBE_ID: name, AZHI_PROBE_DIR: path.join(ROOT, name) },
  });
  const out = { id: name, exit: r.status };
  if (r.error && r.error.code === 'ETIMEDOUT') {
    emit({ ...out, state: 'not_run', reason: 'timed out' });
    continue;
  }
  if (r.error) {
    emit({ ...out, state: 'not_run', reason: 'could not start ' + clip(m.argv[0], 40) + ': ' + clip(r.error.code || r.error.message, 80) });
    continue;
  }
  const last = String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';
  const hit = /^(REPRODUCED|HELD):\s*(.*)$/s.exec(last);
  if (hit) emit({ ...out, state: hit[1] === 'REPRODUCED' ? 'reproduced' : 'held', observed: clip(hit[2], 300) });
  else emit({ ...out, state: 'not_run', reason: 'no REPRODUCED or HELD line (exit ' + r.status + '): ' + clip(r.stderr || last, 200) });
}
console.log('AZHI_PROBES_DONE ' + count);
