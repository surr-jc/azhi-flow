// Prints the two test commands of workflow.yaml: gate.js compressed and wrapped so the same string runs in
// cmd.exe and in sh, with `full` or `static` as the argument. Usage: node examples/sdlc-universal/scripts/build_gate_commands.mjs
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

const src = readFileSync(new URL('./gate.js', import.meta.url), 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');
const b64 = deflateRawSync(Buffer.from(src, 'utf8'), { level: 9 }).toString('base64');
const out = {};
for (const mode of ['full', 'static']) {
  const command = `node -e "eval(require('zlib').inflateRawSync(Buffer.from('${b64}','base64'))+'')" ${mode}`;
  if (command.length > 1000) throw new Error(`the ${mode} command is ${command.length} characters; a test command may have at most 1000`);
  out[mode] = command;
}
console.log(JSON.stringify(out, null, 2));
