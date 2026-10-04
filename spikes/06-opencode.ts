/**
 * Spike 6: OpenCode headless.
 *
 * Starts `opencode serve` in a scratch project whose config (a) bridges the Azhi gateway as a local
 * MCP server and (b) disables OpenCode's built-in tools. Then asks the server what it really
 * exposes. Prompting needs a model provider key; without one, `usage` and `structuredOutput`
 * stay "unverified".
 *
 * Run: npx tsx spikes/06-opencode.ts
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'azhi-opencode-'));
const ambient = ['bash', 'edit', 'write', 'read', 'grep', 'glob', 'list', 'patch', 'webfetch', 'todowrite', 'todoread', 'task'];
writeFileSync(
  join(dir, 'opencode.json'),
  JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        'azhi-gateway': {
          type: 'local',
          command: [join(root, 'node_modules/.bin/tsx'), join(root, 'spikes/opencode/gateway-mcp.ts')],
          enabled: true,
        },
      },
      tools: Object.fromEntries(ambient.map((t) => [t, false])),
      permission: { edit: 'deny', bash: 'deny', webfetch: 'deny' },
    },
    null,
    2,
  ),
);

const bin = join(root, 'node_modules/.bin/opencode');
const proc = spawn(bin, ['serve', '--port', '0', '--hostname', '127.0.0.1', '--print-logs'], { cwd: dir, env: { ...process.env, NODE_PATH: join(root, 'node_modules') } });
const url = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('opencode serve did not start')), 30000);
  const scan = (b: Buffer) => {
    const m = /https?:\/\/127\.0\.0\.1:\d+/.exec(b.toString());
    if (m) {
      clearTimeout(timer);
      resolve(m[0]);
    }
  };
  proc.stdout.on('data', scan);
  proc.stderr.on('data', scan);
});

const get = async (p: string) => {
  const r = await fetch(`${url}${p}`);
  return r.ok ? r.json() : { status: r.status, body: await r.text() };
};
await new Promise((r) => setTimeout(r, 4000)); // let MCP servers connect
const mcp = await get('/mcp');
const toolIds = (await get('/experimental/tool/ids')) as string[] | unknown;
const providers = await get('/config/providers');
const agents = (await get('/agent')) as Array<{ name: string; tools?: Record<string, boolean>; permission?: unknown }>;
const build = Array.isArray(agents) ? agents.find((a) => a.name === 'build') : undefined;
const rules = (Array.isArray(build?.permission) ? build!.permission : []) as Array<{ permission: string; pattern: string; action: string }>;
// OpenCode evaluates permission rules in order with the last match winning.
const effective = (perm: string) => [...rules].reverse().find((r) => (r.permission === perm || r.permission === '*') && r.pattern === '*')?.action ?? 'unknown';
const registry = Array.isArray(toolIds) ? (toolIds as string[]) : [];
const undenied = registry.filter((t) => !['invalid'].includes(t) && effective(t) !== 'deny');
const outside = rules.filter((r) => r.permission === 'external_directory' && r.action === 'allow' && !r.pattern.startsWith(dir));
const gatewayOk = (mcp as any)?.['azhi-gateway']?.status === 'connected';

const ocVersion = JSON.parse(readFileSync(join(root, 'node_modules/opencode-ai/package.json'), 'utf8')).version;
console.log(`server            ${url} (opencode ${ocVersion})`);
console.log(`${gatewayOk ? 'PASS' : 'FAIL'}  gateway bridged as MCP server: ${JSON.stringify((mcp as any)?.['azhi-gateway'])}`);
console.log(`INFO  built-in tools in registry: ${registry.join(', ')}`);
console.log(`${undenied.length ? 'WARN' : 'PASS'}  built-in tools still allowed after deny config: ${undenied.join(', ') || 'none'}`);
console.log(`${outside.length ? 'WARN' : 'PASS'}  directories allowed outside the project: ${outside.length} (${[...new Set(outside.map((r) => r.pattern.split('/').slice(0, 4).join('/')))].join(', ')})`);
console.log(`VERDICT  ambientTools=${undenied.length || outside.length ? 'restrictable' : 'disableable'}; usage, structuredOutput, cancellation: unverified without a model provider key`);
proc.kill('SIGTERM');
