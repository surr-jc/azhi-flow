// Puts the compressed probe runner into workflow.yaml as the probe step's test command (after the setup command).
// Run after editing probe-runner.cjs; test/pr-review-adversarial.test.ts fails when the two differ.
// Usage: node examples/pr-review-adversarial/scripts/sync_probe_command.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { probeCommand } from './build_probe_command.mjs';

const file = new URL('../workflow.yaml', import.meta.url);
const yaml = readFileSync(file, 'utf8');
const quoted = probeCommand().replaceAll('"', '\\"');
const next = yaml.replace(/(command: "\{\{probe_setup_command\}\} && )(?:__PROBE_COMMAND__|node -e \\"[^"\n]*?\)\\")(")/, (_m, a, b) => `${a}${quoted}${b}`);
if (next === yaml && !yaml.includes(quoted)) throw new Error('the probe command line was not found in workflow.yaml');
writeFileSync(file, next);
console.log(`probe command: ${quoted.length} characters`);
