// Prints the workspace test command that runs probe-runner.cjs: compressed and wrapped so that the same string
// runs in cmd.exe and in sh (no quotes, percent signs or newlines to trip either). Same technique as
// examples/ai-sdlc-v2/scripts/build_verify_command.mjs. The setup command is put in front by workflow.yaml.
// Usage: node examples/pr-review-adversarial/scripts/build_probe_command.mjs
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

export function probeCommand() {
  const src = readFileSync(new URL('./probe-runner.cjs', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('//'))
    .join('\n');
  const b64 = deflateRawSync(Buffer.from(src, 'utf8'), { level: 9 }).toString('base64');
  return `node -e "eval(require('zlib').inflateRawSync(Buffer.from('${b64}','base64'))+'')"`;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/build_probe_command.mjs')) console.log(probeCommand());
