import { CancelledFailure, Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ARTIFACT_THRESHOLD_BYTES } from '../artifacts/store.js';
import type { PackageManifest } from '../definition/package.js';
import { ErrorClass } from '../lib/errors.js';
import { canonicalJson } from '../lib/hash.js';
import type { ExecActivities, ScriptNodeInput } from '../runtime/activity-types.js';
import type { ApiClient } from './api-client.js';
import type { WorkerCapabilities } from './capabilities.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
const fail = (type: string, message: string, nonRetryable = true) => ApplicationFailure.create({ type, message, nonRetryable });

export interface ScriptWorkerOptions {
  api: ApiClient;
  workerId: string;
  cacheDir: string;
  capabilities: WorkerCapabilities;
  pythonVersion: string;
  /** Called before a package's dependencies are prepared; throws to refuse it (worker trust policy). */
  verifyPackage?: (manifest: PackageManifest, packageHash: string) => Promise<void>;
}

/** Downloads (once) and verifies every file of a package into the worker cache. */
async function preparePackage(o: ScriptWorkerOptions, packageHash: string): Promise<{ dir: string; manifest: PackageManifest }> {
  const manifest = await o.api.get<PackageManifest>(`/v1/packages/${encodeURIComponent(packageHash)}/manifest`);
  const computed = `sha256:${createHash('sha256').update(canonicalJson(manifest)).digest('hex')}`;
  if (computed !== packageHash) throw fail(ErrorClass.workerTrustDenied, `package manifest hash mismatch: expected ${packageHash}, got ${computed}`);
  await o.verifyPackage?.(manifest, packageHash);
  const dir = join(o.cacheDir, 'packages', packageHash.replace(/^sha256:/, ''));
  if (existsSync(join(dir, '.complete'))) return { dir, manifest };
  const staging = `${dir}.${process.pid}.tmp`;
  rmSync(staging, { recursive: true, force: true });
  for (const f of manifest.files) {
    const data = await o.api.raw(`/v1/artifacts/${encodeURIComponent(`sha256:${f.sha256}`)}`);
    if (createHash('sha256').update(data).digest('hex') !== f.sha256) throw fail(ErrorClass.workerTrustDenied, `package file ${f.path} failed its hash check`);
    const target = join(staging, f.path);
    if (!target.startsWith(staging)) throw fail(ErrorClass.workerTrustDenied, `package path escapes the package: ${f.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  writeFileSync(join(staging, '.complete'), packageHash);
  mkdirSync(dirname(dir), { recursive: true });
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);
  return { dir, manifest };
}

/** Replaces artifact handles and deferred refs in a value with their content. */
async function resolveHandles(api: ApiClient, v: unknown): Promise<unknown> {
  if (Array.isArray(v)) return Promise.all(v.map((x) => resolveHandles(api, x)));
  if (v && typeof v === 'object') {
    const o = v as Record<string, any>;
    if (o.$artifact && Object.keys(o).length === 1) return JSON.parse((await api.raw(`/v1/artifacts/${encodeURIComponent(o.$artifact.hash)}`)).toString('utf8'));
    if (o.$artifact_path && Object.keys(o).length === 1) {
      let cur: any = JSON.parse((await api.raw(`/v1/artifacts/${encodeURIComponent(o.$artifact_path.hash)}`)).toString('utf8'));
      for (const seg of o.$artifact_path.path as string[]) cur = cur?.[seg];
      return cur;
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = await resolveHandles(api, x);
    return out;
  }
  return v;
}

function commandFor(o: ScriptWorkerOptions, input: ScriptNodeInput, dir: string): string[] {
  if (input.runtime === 'python') {
    const py = o.capabilities.runtimes.python;
    if (!py) throw fail(ErrorClass.unsupportedCapability, 'this worker has no Python runtime');
    if (py.via === 'uv') {
      const project = existsSync(join(dir, 'pyproject.toml'));
      return project
        ? ['uv', 'run', '--project', dir, ...(existsSync(join(dir, 'uv.lock')) ? ['--frozen'] : []), '--python', o.pythonVersion, 'python', input.entrypoint]
        : ['uv', 'run', '--no-project', '--python', o.pythonVersion, 'python', input.entrypoint];
    }
    return ['python3', input.entrypoint];
  }
  if (!o.capabilities.runtimes.bun) throw fail(ErrorClass.unsupportedCapability, 'this worker has no Bun runtime');
  return ['bun', 'run', input.entrypoint];
}

export function scriptActivities(o: ScriptWorkerOptions): ExecActivities {
  return {
    async runScript(input: ScriptNodeInput) {
      const ctx = Context.current();
      const attempt = ctx.info.attempt;
      const record = (body: Record<string, unknown>) =>
        o.api.post(`/v1/runs/${input.runId}/attempts`, { node_id: input.nodeId, attempt, worker_id: o.workerId, ...body }).catch(() => {});
      await record({ state: 'running' });
      try {
        const { dir, manifest } = await preparePackage(o, input.packageHash);
        if (!manifest.files.some((f) => f.path === input.entrypoint)) throw fail(ErrorClass.contractViolation, `entrypoint ${input.entrypoint} is not in the package`);
        const value = await resolveHandles(o.api, input.input);
        const cmd = commandFor(o, input, dir);
        const limited = input.limits.memoryMb && o.capabilities.limits.memory ? ['prlimit', `--as=${input.limits.memoryMb * 1024 * 1024}`, '--', ...cmd] : cmd;
        const home = mkdtempSync(join(tmpdir(), 'azhi-script-'));
        const stdout = await runProcess(limited, {
          cwd: dir,
          stdin: JSON.stringify(value ?? null),
          timeoutMs: input.limits.timeMs,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: home,
            LANG: 'C.UTF-8',
            UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? join(o.cacheDir, 'uv-cache'),
            UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR ?? join(o.cacheDir, 'python'),
            ...(process.env.UV_PYTHON_DOWNLOADS ? { UV_PYTHON_DOWNLOADS: process.env.UV_PYTHON_DOWNLOADS } : {}),
            AZHI_RUN_ID: input.runId,
            AZHI_NODE_ID: input.nodeId,
            AZHI_GATEWAY_URL: `${o.api.baseUrl.replace(/\/$/, '')}/v1/gateway/call`,
            AZHI_RUN_TOKEN: input.runToken,
          },
        }).finally(() => rmSync(home, { recursive: true, force: true }));

        let output: unknown;
        try {
          output = JSON.parse(stdout.trim() || 'null');
        } catch {
          throw fail(ErrorClass.contractViolation, `script did not print JSON to stdout (got ${JSON.stringify(stdout.slice(0, 120))})`);
        }
        const schema = typeof input.outputSchema === 'string' ? loadSchemaFile(join(dir, input.outputSchema)) : input.outputSchema;
        if (schema) {
          const validate = ajv.compile(schema);
          if (!validate(output)) throw fail(ErrorClass.contractViolation, `script output does not match its output schema: ${ajv.errorsText(validate.errors)}`);
        }
        if (Buffer.byteLength(stdout) > ARTIFACT_THRESHOLD_BYTES) {
          const a = await o.api.post<{ hash: string; size: number }>('/v1/artifacts', { data: Buffer.from(JSON.stringify(output)).toString('base64') });
          output = { $artifact: { hash: a.hash, size: a.size, media_type: 'application/json' } };
        }
        await record({ state: 'succeeded', output });
        return output;
      } catch (err) {
        const cancelled = err instanceof CancelledFailure;
        const f = err instanceof ApplicationFailure ? err : cancelled ? err : ApplicationFailure.create({ type: ErrorClass.transient, message: (err as Error).message });
        await record({ state: cancelled ? 'cancelled' : 'failed', error: { class: (f as ApplicationFailure).type ?? 'cancelled', message: (f as Error).message } });
        throw f;
      }
    },
  };
}

function loadSchemaFile(path: string): Record<string, unknown> {
  const text = readFileSync(path, 'utf8');
  return (path.endsWith('.json') ? JSON.parse(text) : parseYaml(text)) as Record<string, unknown>;
}

/**
 * Runs a script in its own process group with a time limit, heartbeating to Temporal. On
 * cancellation or timeout the whole group is terminated and the termination is confirmed.
 * A subprocess is not a sandbox: only trusted-author packages run here (spec section 10).
 */
function runProcess(cmd: string[], o: { cwd: string; stdin: string; timeoutMs: number; env: Record<string, string> }): Promise<string> {
  const ctx = Context.current();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { cwd: o.cwd, env: o.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const kill = () => {
      try {
        process.kill(-child.pid!, 'SIGTERM');
        setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {}
        }, 3000).unref();
      } catch {}
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(hb);
      clearTimeout(timer);
      fn();
    };
    const hb = setInterval(() => ctx.heartbeat({ stderr_tail: err.slice(-500) }), 2000);
    const timer = setTimeout(() => {
      kill();
      finish(() => reject(ApplicationFailure.create({ type: ErrorClass.transient, message: `script exceeded its time limit of ${o.timeoutMs} ms`, nonRetryable: true })));
    }, o.timeoutMs);
    ctx.cancellationSignal.addEventListener('abort', () => {
      kill();
      child.once('exit', () => finish(() => reject(new CancelledFailure('script cancelled; process group terminated'))));
    });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-65536)));
    child.on('error', (e) => finish(() => reject(ApplicationFailure.create({ type: ErrorClass.unsupportedCapability, message: `cannot start ${cmd[0]}: ${e.message}`, nonRetryable: true }))));
    child.on('exit', (code, signal) => {
      if (code === 0) finish(() => resolve(out));
      else
        finish(() =>
          reject(
            ApplicationFailure.create({
              type: signal === 'SIGKILL' && cmd[0] === 'prlimit' ? ErrorClass.budgetExceeded : ErrorClass.transient,
              message: `script exited with ${signal ?? `code ${code}`}: ${err.trim().split('\n').slice(-3).join(' | ').slice(0, 500)}`,
            }),
          ),
        );
    });
    child.stdin.end(o.stdin);
  });
}

