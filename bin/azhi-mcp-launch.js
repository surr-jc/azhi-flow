#!/usr/bin/env node
// Starts a package's MCP server for an OpenCode step on Windows, which has no `env -u`: OpenCode hands
// MCP servers its own environment, and the names given before `--` (its model sign-in and server
// password) are taken out first. Usage: azhi-mcp-launch.js NAME[,NAME...] -- COMMAND [ARGS...]
// Plain JavaScript with no imports from the project, so it starts quickly.
import { spawn, execFileSync } from 'node:child_process';
import { extname } from 'node:path';

const sep = process.argv.indexOf('--');
if (sep < 3 || sep === process.argv.length - 1) {
  console.error('usage: azhi-mcp-launch.js NAME[,NAME...] -- COMMAND [ARGS...]');
  process.exit(2);
}
const remove = new Set(process.argv[2].split(',').filter(Boolean).map((k) => k.toUpperCase()));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !remove.has(k.toUpperCase())));
let [cmd, ...args] = process.argv.slice(sep + 1);

const win = process.platform === 'win32';
// A bare name (npx, uvx) is looked up the way a Windows shell would, so npm's .cmd wrappers are found too.
if (win && !/[\\/]/.test(cmd) && !extname(cmd)) {
  try {
    cmd = execFileSync('where', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env, windowsHide: true }).split(/\r?\n/)[0].trim() || cmd;
  } catch {
    // not found: spawn reports it
  }
}

// A .cmd or .bat runs only through cmd.exe. Each argument is quoted and cmd's special characters escaped
// (the way cross-spawn does it), so an argument cannot end the command or start another.
const batch = win && /\.(cmd|bat)$/i.test(cmd);
const meta = /([()\][%!^"`<>&|;, *?])/g;
const quote = (a) => `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(meta, '^$1');
const child = batch
  ? spawn(env.ComSpec || env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', `"${[cmd.replace(meta, '^$1'), ...args.map(quote)].join(' ')}"`], { env, stdio: 'inherit', windowsVerbatimArguments: true, windowsHide: true })
  : spawn(cmd, args, { env, stdio: 'inherit', windowsHide: true });

child.on('error', (e) => {
  console.error(`azhi-mcp-launch: ${cmd}: ${e.message}`);
  process.exit(127);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
