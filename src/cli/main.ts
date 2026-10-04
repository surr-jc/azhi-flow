import { Command } from 'commander';
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../compiler/compile.js';
import { loadAdminConfig } from '../config/admin.js';
import { settings } from '../config/settings.js';
import { createDb } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { loadDefinitionText } from '../definition/load.js';
import { packageFromDirectory, type PackageSource } from '../definition/package.js';
import { workflowSchema } from '../definition/schema.js';
import { staticCatalog, type ToolCatalog } from '../gateway/types.js';
import { ALL_ROLES, startServer, type ServerRole } from '../server/server.js';
import { ApiClient } from '../worker/api-client.js';
import { startWorker } from '../worker/worker.js';
import { apiClient, resolveCliConfig, saveCliConfig } from './client-config.js';
import { printContext, printInspect } from './inspect.js';
import { signForUpload } from './signing-client.js';
import { parseTrustPolicy } from '../security/signing.js';
import type { RunPlanReport } from '../plan/run-plan.js';
import { bold, dim, green, printDiagnostics, printPlan, red, table, yellow } from './output.js';

const program = new Command('azhi').description('Azhi Flow: governed, durable agent workflows').version('0.1.0');
program.option('--url <url>', 'server URL (default: $AZHI_URL, saved login, or the local server)').option('--token <token>', 'API token');

const client = () => apiClient(program.opts());

export function loadPackage(path: string): PackageSource {
  const dir = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path);
  return packageFromDirectory(dir);
}

export function localCatalog(configPath?: string): ToolCatalog | undefined {
  const path = configPath ?? (existsSync('azhi.config.yaml') ? 'azhi.config.yaml' : undefined);
  if (!path) return undefined;
  return staticCatalog(loadAdminConfig(path).tools ?? []);
}

function packageUpload(pkg: PackageSource) {
  const files: Record<string, string> = {};
  for (const f of pkg.manifest.files) files[f.path] = pkg.read(f.path)!.toString('base64');
  return { workflow: pkg.manifest.workflow, files };
}

function parseInputs(pairs: string[] = [], file?: string): Record<string, unknown> {
  const inputs: Record<string, unknown> = file ? JSON.parse(readFileSync(file, 'utf8')) : {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i < 1) throw new Error(`--input expects key=value, got '${p}'`);
    const raw = p.slice(i + 1);
    try {
      inputs[p.slice(0, i)] = JSON.parse(raw);
    } catch {
      inputs[p.slice(0, i)] = raw;
    }
  }
  return inputs;
}

const collect = (v: string, prev: string[] = []) => [...prev, v];

async function upload(path: string) {
  const pkg = loadPackage(path);
  const api = client();
  const def = loadDefinitionText(pkg.readText(pkg.manifest.workflow)!).definition;
  // Every upload is signed with this user's publisher key, so workers can apply trust policies.
  const signature = def ? await signForUpload(api, pkg, def.id) : undefined;
  const r = await api.post<{ ok: boolean; diagnostics: any[]; version?: { id: string; workflow: string; version: number; package_hash: string } }>('/v1/packages', {
    ...packageUpload(pkg),
    signature,
  });
  printDiagnostics(r.diagnostics);
  if (!r.ok) {
    console.error(red('package rejected by the server compiler'));
    process.exit(1);
  }
  return r.version!;
}

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '../../examples');
const templateNames = () => (existsSync(TEMPLATES) ? readdirSync(TEMPLATES) : []);

program
  .command('init')
  .description('Create a workflow package from a template (default: the weekly quality report)')
  .argument('[dir]', 'directory to create', 'quality-report')
  .option('-t, --template <name>', `template: ${templateNames().join(' | ') || 'quality-report'}`, 'quality-report')
  .action((dir: string, opts: { template: string }) => {
    const from = join(TEMPLATES, opts.template);
    if (!existsSync(from)) throw new Error(`no template '${opts.template}' (have: ${templateNames().join(', ') || 'none'})`);
    if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} exists and is not empty`);
    cpSync(from, dir, { recursive: true });
    console.log(`${green('created')} ${resolve(dir)} from the ${opts.template} template`);
    console.log(`next: azhi apply ${join(dir, 'azhi.config.yaml')} && azhi plan ${dir}`);
  });

program
  .command('validate')
  .description('Validate a workflow package locally and print diagnostics')
  .argument('[path]', 'package directory or workflow.yaml', '.')
  .option('-c, --config <file>', 'admin config with the tool catalog (default: ./azhi.config.yaml)')
  .option('--json', 'print the execution plan as JSON')
  .action((path: string, opts: { config?: string; json?: boolean }) => {
    const pkg = loadPackage(path);
    const loaded = loadDefinitionText(pkg.readText(pkg.manifest.workflow)!);
    if (!loaded.definition) {
      printDiagnostics(loaded.diagnostics);
      process.exitCode = 1;
      return;
    }
    const result = compile(loaded.definition, { pkg, catalog: localCatalog(opts.config) });
    printDiagnostics(result.diagnostics);
    if (!result.ok) {
      console.log(red(`\n${loaded.definition.id}: invalid`));
      process.exitCode = 1;
      return;
    }
    if (opts.json) console.log(JSON.stringify(result.plan, null, 2));
    else console.log(`${green('valid')} ${bold(loaded.definition.id)}: ${result.plan!.nodes.length} nodes, package ${pkg.hash.slice(0, 19)}`);
  });

program
  .command('schema')
  .description('Print the workflow JSON Schema (schema_version 2.x)')
  .action(() => console.log(JSON.stringify(workflowSchema, null, 2)));

program
  .command('run')
  .description('Upload a package and run it')
  .argument('[path]', 'package directory, or workflow@version with --published', '.')
  .option('-i, --input <key=value>', 'input value (JSON or string); repeatable', collect)
  .option('--inputs <file>', 'JSON file with inputs')
  .option('--published', 'run a published version (workflow, workflow@3) instead of uploading')
  .option('-w, --wait', 'wait for the run to finish and print the result')
  .action(async (path: string, opts: { input?: string[]; inputs?: string; published?: boolean; wait?: boolean }) => {
    const version = opts.published ? path : (await upload(path)).id;
    const api = client();
    const { run_id } = await api.post<{ run_id: string }>('/v1/runs', { version, inputs: parseInputs(opts.input, opts.inputs) });
    console.log(`run ${bold(run_id)} queued`);
    if (!opts.wait) return;
    let cursor = 0;
    for (;;) {
      const events = await api.get<Array<{ seq: number; kind: string; node_id: string | null; data: any; at: string }>>(`/v1/runs/${run_id}/events?after=${cursor}`);
      for (const e of events) {
        cursor = e.seq;
        if (e.kind.startsWith('node.') && e.kind !== 'node.running') {
          const mark = e.kind === 'node.succeeded' ? green('✓') : e.kind === 'node.failed' ? red('✗') : dim('·');
          console.log(`  ${mark} ${e.node_id} ${dim(e.kind.slice(5))}${e.data?.error ? ` ${red(e.data.error.message)}` : ''}`);
        }
        if (e.kind === 'run.waiting') console.log(`  ${yellow('…')} waiting: ${JSON.stringify(e.data?.flags?.waiting_reason ?? {})}`);
      }
      const d = await api.get<any>(`/v1/runs/${run_id}`);
      if (['succeeded', 'delivery_failed', 'failed', 'cancelled', 'expired'].includes(d.run.state)) {
        printInspect(d);
        process.exitCode = d.run.state === 'succeeded' ? 0 : 1;
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  });

program
  .command('gateway-mcp', { hidden: true })
  .description('Serve the tool gateway over stdio MCP for a harness (configured by the adapter)')
  .action(async () => {
    const { runGatewayBridge } = await import('../agents/gateway-mcp.js');
    await runGatewayBridge();
  });

program
  .command('test-node')
  .description('Run one node on fixture inputs with writes mocked (a test run, excluded from analytics)')
  .argument('<node>', 'node ID')
  .argument('[path]', 'package directory', '.')
  .option('-f, --fixture <file>', 'JSON: { "inputs": {...}, "nodes": { "<upstream id>": <output> } }')
  .action(async (node: string, path: string, opts: { fixture?: string }) => {
    const fixture = opts.fixture ? (JSON.parse(readFileSync(opts.fixture, 'utf8')) as { inputs?: Record<string, unknown>; nodes?: Record<string, unknown> }) : {};
    const version = (await upload(path)).id;
    const api = client();
    const { run_id } = await api.post<{ run_id: string }>('/v1/runs', { version, inputs: fixture.inputs ?? {}, test: true, node, fixtures: fixture.nodes ?? {} });
    for (;;) {
      const d = await api.get<any>(`/v1/runs/${run_id}`);
      if (['succeeded', 'delivery_failed', 'failed', 'cancelled', 'expired'].includes(d.run.state)) {
        const a = d.attempts.filter((x: any) => x.node_id === node).at(-1);
        console.log(`${bold(node)} ${a?.state === 'succeeded' ? green('succeeded') : red(a?.state ?? d.run.state)} ${dim(`test run ${run_id}`)}`);
        if (a?.error) console.log(red(`[${a.error.class}] ${a.error.message}`));
        else if (d.run.error) console.log(red(`[${d.run.error.class}] ${d.run.error.message}`));
        if (a?.output !== undefined && a?.output !== null) console.log(JSON.stringify(a.output, null, 2));
        if (d.usage?.turns) console.log(dim(`${d.usage.turns} model turns; azhi inspect ${run_id} --context ${node}`));
        process.exitCode = a?.state === 'succeeded' ? 0 : 1;
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  });

program
  .command('plan')
  .description('Show the run plan: capability marks, policy coverage, taint paths, missing grants and blockers')
  .argument('[path]', 'package directory, or workflow@version with --published', '.')
  .option('--published', 'plan a published version instead of uploading')
  .option('--json', 'print raw JSON')
  .action(async (path: string, opts: { published?: boolean; json?: boolean }) => {
    const version = opts.published ? path : (await upload(path)).id;
    const plan = await client().get<RunPlanReport>(`/v1/versions/${encodeURIComponent(version)}/plan`);
    if (opts.json) console.log(JSON.stringify(plan, null, 2));
    else printPlan(plan);
    process.exitCode = plan.ok ? 0 : 1;
  });

program
  .command('inspect')
  .description('Show a run: state, flags, nodes, attempts and the action ledger')
  .argument('<run-id>')
  .option('--json', 'print raw JSON')
  .option('--context <node>', 'show the context manifest of an agent node')
  .action(async (runId: string, opts: { json?: boolean; context?: string }) => {
    const d = await client().get<any>(`/v1/runs/${runId}`);
    if (opts.json) console.log(JSON.stringify(d, null, 2));
    else if (opts.context) printContext(d, opts.context);
    else printInspect(d);
  });

program
  .command('open')
  .description('Print a link to the run page (or the runs list) that signs this browser tab in')
  .argument('[run-id]')
  .action((runId: string | undefined) => {
    const cfg = resolveCliConfig(program.opts());
    // The token rides in the URL fragment, which browsers never send to the server or in Referer.
    console.log(`${cfg.url.replace(/\/$/, '')}/ui${runId ? `/runs/${encodeURIComponent(runId)}` : ''}#token=${encodeURIComponent(cfg.token)}`);
  });

program
  .command('runs')
  .description('List recent runs')
  .option('-n, --limit <n>', 'how many', '20')
  .action(async (opts: { limit: string }) => {
    const rows = await client().get<any[]>(`/v1/runs?limit=${opts.limit}`);
    table([['RUN', 'WORKFLOW', 'STATE', 'TRIGGER', 'CREATED'], ...rows.map((r) => [r.id, `${r.workflow}@${r.version}`, r.state, r.trigger, new Date(r.created_at).toISOString()])]);
  });

program
  .command('cancel')
  .description('Cancel a run')
  .argument('<run-id>')
  .action(async (runId: string) => {
    await client().post(`/v1/runs/${runId}/cancel`);
    console.log(`cancel requested for ${runId}`);
  });

program
  .command('approve')
  .description('Decide an approval node of a waiting run')
  .argument('<run-id>')
  .argument('<node>', 'approval node ID')
  .option('--reject', 'reject instead of approve; nodes downstream are skipped')
  .option('--data <json>', 'decision data matching the node decision_schema')
  .action(async (runId: string, node: string, opts: { reject?: boolean; data?: string }) => {
    const decision = opts.reject ? 'rejected' : 'approved';
    await client().post(`/v1/runs/${runId}/approvals`, { node, decision, data: opts.data ? JSON.parse(opts.data) : {} });
    console.log(`${decision === 'approved' ? green('approved') : yellow('rejected')} ${node} on ${runId}`);
  });

program
  .command('publish')
  .description('Upload a package and publish it as the version schedules run')
  .argument('[path]', 'package directory', '.')
  .action(async (path: string) => {
    const v = await upload(path);
    const p = await client().post<{ workflow: string; version: number }>(`/v1/versions/${v.id}/publish`, {});
    console.log(`${green('published')} ${p.workflow}@${p.version} (${v.package_hash.slice(0, 19)})`);
  });

program
  .command('apply')
  .description('Apply an admin config: register tools and schedules, check secrets')
  .argument('<file>', 'azhi.config.yaml')
  .action(async (file: string) => {
    const cfg = loadAdminConfig(file);
    const api = client();
    for (const t of cfg.tools ?? []) {
      const r = await api.post<{ revision: number; changed: boolean }>('/v1/tools', t);
      console.log(`tool ${t.id}@${t.version}: ${r.changed ? `registered revision ${r.revision}` : `unchanged (revision ${r.revision})`}`);
    }
    for (const s of cfg.schedules ?? []) {
      await api.post('/v1/schedules', { workflow: s.workflow, cron: s.cron, timezone: s.timezone, inputs: s.inputs ?? {}, enabled: s.enabled ?? true });
      console.log(`schedule for ${s.workflow}: ${s.cron} ${s.timezone}`);
    }
    if (cfg.secrets?.length) {
      const set = new Set((await api.get<Array<{ name: string }>>('/v1/secrets')).map((s) => s.name));
      for (const name of cfg.secrets) console.log(`secret ${name}: ${set.has(name) ? green('set') : yellow('missing (azhi secret set ' + name + ')')}`);
    }
  });

const dataset = program.command('dataset').description('Manage knowledge datasets (Markdown and plain text)');
dataset
  .command('create')
  .argument('<name>')
  .option('--untrusted', 'mark content as untrusted: agents that read it are tainted')
  .option('--roles <roles>', 'comma-separated roles that may read it', 'viewer')
  .action(async (name: string, opts: { untrusted?: boolean; roles: string }) => {
    await client().post('/v1/datasets', { name, trusted: !opts.untrusted, acl: { roles: opts.roles.split(',') } });
    console.log(`dataset ${bold(name)} ready${opts.untrusted ? yellow(' (untrusted)') : ''}`);
  });
dataset
  .command('add')
  .description('Add or replace documents; files or directories (.md, .txt)')
  .argument('<name>')
  .argument('<paths...>')
  .action(async (name: string, paths: string[]) => {
    const docs = collectDocuments(paths);
    const r = await client().post<{ documents: Array<{ path: string; changed: boolean }> }>(`/v1/datasets/${name}/documents`, { documents: docs });
    for (const d of r.documents) console.log(`  ${d.changed ? green('+') : dim('=')} ${d.path}`);
    console.log(`${r.documents.filter((d) => d.changed).length} changed; run ${bold(`azhi dataset publish ${name}`)} to index them`);
  });
dataset
  .command('publish')
  .description('Chunk, embed and publish an immutable index revision')
  .argument('<name>')
  .option('-t, --tag <tag>', 'also point this tag (for example approved) at the new revision')
  .action(async (name: string, opts: { tag?: string }) => {
    const r = await client().post<{ revision: number; documents: number; chunks: number; embedder: string }>(`/v1/datasets/${name}/publish`, { tag: opts.tag });
    console.log(`${green('published')} ${name}@${r.revision}: ${r.documents} documents, ${r.chunks} chunks (${r.embedder})${opts.tag ? `, tagged ${opts.tag}` : ''}`);
  });
dataset
  .command('tag')
  .argument('<name>')
  .argument('<tag>')
  .argument('<revision>')
  .action(async (name: string, tag: string, revision: string) => {
    await client().put(`/v1/datasets/${name}/tags/${tag}`, { revision: Number(revision) });
    console.log(`${name}@${tag} -> revision ${revision}`);
  });
dataset
  .command('revoke')
  .description('Stop a document being retrievable, from every revision')
  .argument('<name>')
  .argument('<path>')
  .action(async (name: string, path: string) => {
    await client().del(`/v1/datasets/${name}/documents?path=${encodeURIComponent(path)}`);
    console.log(`revoked ${path} in ${name}`);
  });
dataset
  .command('search')
  .description('Run hybrid retrieval against a dataset revision')
  .argument('<ref>', 'name, name@tag or name@revision')
  .argument('<query>')
  .option('-k, --top-k <n>', 'chunks to return', '6')
  .action(async (ref: string, query: string, opts: { topK: string }) => {
    const r = await client().post<{ revision: number; chunks: any[] }>(`/v1/datasets/${encodeURIComponent(ref)}/search`, { query, top_k: Number(opts.topK) });
    console.log(dim(`revision ${r.revision}`));
    for (const c of r.chunks) console.log(`${bold(c.citation_id)} ${c.document}:${c.start}-${c.end} ${dim(c.heading)} ${dim(c.score.toFixed(4))}\n  ${c.text.slice(0, 160).replace(/\n/g, ' ')}`);
  });
dataset
  .command('list')
  .action(async () => {
    const rows = await client().get<any[]>('/v1/datasets');
    table([['DATASET', 'TRUSTED', 'DOCS', 'LATEST', 'TAGS'], ...rows.map((d) => [d.name, d.trusted ? 'yes' : 'no', String(d.documents), String(d.latest_revision ?? '-'), Object.entries(d.tags).map(([t, r]) => `${t}=${r}`).join(' ')])]);
  });

function collectDocuments(paths: string[]): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  const walk = (p: string, rel: string) => {
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) walk(join(p, f), rel ? `${rel}/${f}` : f);
    } else if (/\.(md|markdown|txt|text)$/i.test(p)) out.push({ path: rel, content: readFileSync(p, 'utf8') });
  };
  for (const p of paths) walk(p, statSync(p).isDirectory() ? '' : basename(p));
  return out;
}

/**
 * A secret piped on stdin. Windows PowerShell 5.1 pipes text to programs as UTF-16 or with a
 * byte-order mark, which would end up inside the secret (and break HTTP headers), so both are undone.
 */
function readSecretStdin(): string {
  const raw = readFileSync(0);
  const utf16 = raw[0] === 0xff && raw[1] === 0xfe ? raw.subarray(2).toString('utf16le') : raw.length > 1 && raw[1] === 0 ? raw.toString('utf16le') : undefined;
  return (utf16 ?? raw.toString('utf8')).replace(/^﻿/, '').replace(/ /g, '').trim();
}

const secret = program.command('secret').description('Manage workspace secrets');
secret
  .command('set')
  .argument('<name>')
  .option('--value <value>', 'secret value (default: read from stdin)')
  .action(async (name: string, opts: { value?: string }) => {
    const value = opts.value ?? readSecretStdin();
    const r = await client().put<{ version: number }>(`/v1/secrets/${name}`, { value });
    console.log(`secret ${name} set (version ${r.version})`);
  });
secret.command('list').action(async () => {
  const rows = await client().get<any[]>('/v1/secrets');
  table([['NAME', 'VERSION', 'UPDATED'], ...rows.map((r) => [r.name, String(r.version), new Date(r.updated_at).toISOString()])]);
});

program
  .command('schedule')
  .description('Set the schedule of a workflow (runs its latest published version)')
  .argument('<workflow>')
  .requiredOption('--cron <expr>')
  .requiredOption('--timezone <iana>')
  .option('-i, --input <key=value>', 'input value; repeatable', collect)
  .option('--disable', 'disable the schedule')
  .action(async (workflow: string, opts: { cron: string; timezone: string; input?: string[]; disable?: boolean }) => {
    const s = await client().post<any>('/v1/schedules', { workflow, cron: opts.cron, timezone: opts.timezone, inputs: parseInputs(opts.input), enabled: !opts.disable });
    console.log(`schedule ${s.id}: next occurrence ${new Date(s.next_occurrence_at).toISOString()}`);
  });

const users = program.command('user').description('Manage workspace users (admin)');
users
  .command('add')
  .argument('<name>')
  .requiredOption('--role <role>', 'admin | author | operator | viewer')
  .option('--email <email>')
  .action(async (name: string, opts: { role: string; email?: string }) => {
    const r = await client().post<{ id: string; token: string }>('/v1/users', { display_name: name, role: opts.role, email: opts.email });
    console.log(`user ${r.id} (${opts.role}) created. API token, shown once:\n  ${r.token}`);
  });
users.command('list').action(async () => {
  const rows = await client().get<any[]>('/v1/users');
  table([['ID', 'NAME', 'ROLE'], ...rows.map((u) => [u.id, u.display_name ?? '', u.role])]);
});

program
  .command('login')
  .description('Save the server URL and API token for this CLI (--url and --token)')
  .action(async () => {
    // --url and --token are program-level options, so commander parses them before this
    // subcommand runs; read them from there rather than declaring them again on `login`.
    const { url, token } = program.opts<{ url?: string; token?: string }>();
    if (!url || !token) throw new Error('usage: azhi login --url <server> --token <token>');
    // Check the credentials before saving them, so a typo never replaces a working login.
    const me = await new ApiClient(url, token).get<any>('/v1/me');
    saveCliConfig({ url, token });
    console.log(`logged in to ${url} as ${me.userId} (${me.role})`);
  });

program
  .command('doctor')
  .description('Check the server, database, Temporal, workers and interpreter builds')
  .action(async () => {
    let ok = true;
    try {
      const r = await client().get<{ ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> }>('/v1/doctor');
      for (const c of r.checks) console.log(`${c.ok ? green('ok  ') : red('FAIL')} ${c.name}: ${c.detail}`);
      ok = r.ok;
    } catch (e) {
      console.log(`${red('FAIL')} server: ${(e as Error).message}`);
      ok = false;
    }
    process.exitCode = ok ? 0 : 1;
  });

program
  .command('up')
  .description('Run Azhi on this machine without Docker: embedded database, Temporal dev server, server and a worker')
  .option('--port <port>', 'web and API port (default: $AZHI_PORT or 7400)')
  .option('--no-worker', 'do not start an execution worker')
  .action(async (opts: { port?: string; worker: boolean }) => {
    const { startLocal } = await import('../local/up.js');
    const h = await startLocal({ port: opts.port ? Number(opts.port) : undefined, worker: opts.worker });
    console.log(`\n${green('Azhi is running')} at ${h.url}`);
    console.log(`Web UI: ${h.url.replace(/\/$/, '')}/ui#token=${encodeURIComponent(h.token)}`);
    console.log(dim(`Data in ${(await import('../local/up.js')).localHome()}. Stop with Ctrl+C or 'azhi down'.\n`));
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await h.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('down')
  .description("Stop Azhi started with 'azhi up'")
  .action(async () => {
    const { stopLocal } = await import('../local/up.js');
    console.log((await stopLocal()) ? 'stopped' : 'Azhi is not running locally');
  });

const server = program.command('server').description('Run the Azhi server');
server
  .command('start')
  .option('--roles <roles>', `comma-separated roles: ${ALL_ROLES.join(',')}`, ALL_ROLES.join(','))
  .action(async (opts: { roles: string }) => {
    const h = await startServer({ roles: opts.roles.split(',') as ServerRole[] });
    if (h.localToken) console.log(`\nLocal owner token (also in ${h.localTokenFile}):\n  ${h.localToken}\n`);
    const shutdown = async () => {
      await h.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
server
  .command('migrate')
  .description('Apply database migrations and exit')
  .action(async () => {
    const db = createDb(settings().databaseUrl);
    const applied = await migrate(db.$client);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
    await db.$client.end();
  });

const worker = program.command('worker').description('Run an execution worker on this Linux host');
worker
  .command('start')
  .option('--name <name>', 'worker name (default: hostname)')
  .option('--temporal <address>', 'Temporal address', process.env.AZHI_TEMPORAL_ADDRESS ?? 'localhost:7233')
  .option('--trust <policy>', 'whose packages this worker runs: self | authors:<user,...> | workspace-publishers', 'self')
  .action(async (opts: { name?: string; temporal: string; trust: string }) => {
    const cfg = resolveCliConfig(program.opts());
    const w = await startWorker({ apiUrl: cfg.url, token: cfg.token, temporalAddress: opts.temporal, name: opts.name, trustPolicy: parseTrustPolicy(opts.trust) });
    const shutdown = async () => {
      await w.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(red(`error: ${err.message}`));
  process.exit(1);
});
