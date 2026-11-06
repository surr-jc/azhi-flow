// Prints the two test commands of workflow.yaml: gate.js compressed and wrapped so the same string runs in
// cmd.exe and in sh, with `full` or `static` as the argument. A command may be at most 8000 characters (cmd.exe
// stops at 8191).
// Usage: node examples/sdlc-universal/scripts/build_gate_commands.mjs           print both commands as JSON
//        node examples/sdlc-universal/scripts/build_gate_commands.mjs --write   also rewrite them in workflow.yaml
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

const LIMIT = 8000;
const src = readFileSync(new URL('./gate.js', import.meta.url), 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');
const b64 = deflateRawSync(Buffer.from(src, 'utf8'), { level: 9 }).toString('base64');
const out = {};
for (const mode of ['full', 'static']) {
  const command = `node -e "eval(require('zlib').inflateRawSync(Buffer.from('${b64}','base64'))+'')" ${mode}`;
  if (command.length > LIMIT) throw new Error(`the ${mode} command is ${command.length} characters; a test command may have at most ${LIMIT}`);
  out[mode] = command;
}

if (process.argv.includes('--write')) {
  const file = new URL('../workflow.yaml', import.meta.url);
  const yaml = readFileSync(file, 'utf8');
  // The command is a plain scalar that the YAML writer folded after `node -e` and before the mode word.
  const re = /node -e\s+"eval\(require\('zlib'\)\.inflateRawSync\(Buffer\.from\('[^']*','base64'\)\)\+''\)"\s+(full|static)/g;
  let n = 0;
  const next = yaml.replace(re, (_m, mode) => {
    n++;
    return out[mode];
  });
  writeFileSync(file, next);
  console.error(`rewrote ${n} command(s) in workflow.yaml`);
}
console.log(JSON.stringify(out, null, 2));
