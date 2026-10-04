import { Command } from 'commander';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
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
import { startWorker } from '../worker/worker.js';
import { apiClient, resolveCliConfig, saveCliConfig } from './client-config.js';
import { printInspect } from './inspect.js';
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
  .action(async (runId: string, opts: { json?: boolean }) => {
    const d = await client().get<any>(`/v1/runs/${runId}`);
    if (opts.json) console.log(JSON.stringify(d, null, 2));
    else printInspect(d);
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

const secret = program.command('secret').description('Manage workspace secrets');
secret
  .command('set')
  .argument('<name>')
  .option('--value <value>', 'secret value (default: read from stdin)')
  .action(async (name: string, opts: { value?: string }) => {
    const value = opts.value ?? readFileSync(0, 'utf8').trim();
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
  .description('Save the server URL and API token for this CLI')
  .requiredOption('--url <url>')
  .requiredOption('--token <token>')
  .action(async (opts: { url: string; token: string }) => {
    saveCliConfig({ url: opts.url, token: opts.token });
    const me = await client().get<any>('/v1/me');
    console.log(`logged in to ${opts.url} as ${me.userId} (${me.role})`);
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
