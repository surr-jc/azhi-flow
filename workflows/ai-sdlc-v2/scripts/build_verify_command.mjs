// Prints the test command for the static verification: verify_static.js, compressed and wrapped so that the
// same string runs in cmd.exe and in sh (no quotes, percent signs or newlines to trip either).
// Usage: node workflows/ai-sdlc-v2/scripts/build_verify_command.mjs
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

const src = readFileSync(new URL('./verify_static.js', import.meta.url), 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');
const b64 = deflateRawSync(Buffer.from(src, 'utf8'), { level: 9 }).toString('base64');
const command = `node -e "eval(require('zlib').inflateRawSync(Buffer.from('${b64}','base64'))+'')"`;
if (command.length > 1000) throw new Error(`the command is ${command.length} characters; a test command may have at most 1000`);
console.log(command);
