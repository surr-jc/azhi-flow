import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ARTIFACT_THRESHOLD_BYTES, type ArtifactHandle } from '../artifacts/store.js';
import { loadToolRevision } from '../server/catalog.js';
import type { AppContext } from '../server/context.js';
import { resolveSecret } from '../server/secrets.js';
import { parseDuration } from '../lib/duration.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { canonicalJson, sha256 } from '../lib/hash.js';
import { byteSize } from '../lib/json.js';
import { executorFor, type ExecContext } from './executors.js';
import { ledgeredWrite, SendError } from './ledger.js';
import { project } from './projection.js';
import { toolRef, type ToolSpec } from './types.js';

/**
 * The tool gateway (spec section 9): the single point for authorisation, argument validation,
 * projection, observation records and the action ledger. Tool nodes, notify nodes, scripts and
 * agents all reach tools through here.
 */
const ajv = new Ajv2020({ allErrors: true, strict: false });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
function validator(schema: object) {
  const key = canonicalJson(schema);
  let v = validators.get(key);
  if (!v) validators.set(key, (v = ajv.compile(schema)));
  return v;
}

export interface ToolCallRequest {
  workspaceId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  tool: string;
  /** Revision pinned in the run snapshot. */
  revision?: number;
  args: Record<string, unknown>;
  project?: string[];
  /** The tools this caller may use (workflow allowlist, run-scoped token). */
  allowed: string[];
  /** Distinguishes identical writes within one node, such as parallel items. */
  ordinal?: number;
}

export interface Observation {
  tool: string;
  source: string;
  observed_at: string;
  query_hash: string;
  etag?: string;
  artifact: string;
}

export interface ToolCallResult {
  output: unknown;
  observation: Observation;
  action?: { id: string; reused: boolean };
}

const buckets = new Map<string, { tokens: number; at: number }>();
function rateLimit(key: string, perMinute: number) {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: perMinute, at: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
  b.at = now;
  if (b.tokens < 1) throw new AzhiError(ErrorClass.transient, `rate limit for ${key} reached (${perMinute}/min)`);
  b.tokens -= 1;
  buckets.set(key, b);
}

export async function callTool(ctx: AppContext, req: ToolCallRequest): Promise<ToolCallResult> {
  if (!req.allowed.includes(req.tool)) throw new AzhiError(ErrorClass.authorization, `tool ${req.tool} is not allowed for node ${req.nodeId}`);
  const spec = await loadToolRevision(ctx, req.workspaceId, req.tool, req.revision);
  if (!spec) throw new AzhiError(ErrorClass.unsupportedCapability, `tool ${req.tool}${req.revision ? ` revision ${req.revision}` : ''} is not registered`);

  const validArgs = validator(spec.input_schema);
  if (!validArgs(req.args)) {
    throw new AzhiError(ErrorClass.invalidInput, `arguments for ${req.tool} are invalid: ${ajv.errorsText(validArgs.errors)}`, {
      failed_fields: (validArgs.errors ?? []).map((e) => e.instancePath || e.params),
    });
  }
  if (spec.rate_limit) rateLimit(`${req.workspaceId}:${req.tool}`, spec.rate_limit.per_minute);

  const credential = spec.credential ? await resolveSecret(ctx, req.workspaceId, spec.credential) : undefined;
  if (spec.credential && !credential) throw new AzhiError(ErrorClass.authorization, `credential '${spec.credential}' for ${req.tool} is not set`);
  const exec = executorFor(spec);
  const execCtx: ExecContext = {
    app: ctx,
    workspaceId: req.workspaceId,
    credential: credential?.value,
    timeoutMs: spec.timeout ? parseDuration(spec.timeout) : 30_000,
    slackApiUrl: ctx.settings.slackApiUrl,
  };

  let value: unknown;
  let etag: string | undefined;
  let action: ToolCallResult['action'];
  if (spec.effect === 'read') {
    const r = await withTimeout(exec.call(spec, req.args, execCtx), execCtx.timeoutMs, req.tool).catch(mapSendError);
    value = r.value;
    etag = r.etag;
  } else {
    const r = await ledgeredWrite(
      { pool: ctx.pool, workspaceId: req.workspaceId, runId: req.runId, nodeId: req.nodeId, fence: req.attempt },
      { tool: toolRef(spec), effect: spec.effect, operation: req.args, target: targetOf(spec, req.args), ordinal: req.ordinal },
      {
        send: async (key) => (await withTimeout(exec.call(spec, req.args, { ...execCtx, idempotencyKey: key }), execCtx.timeoutMs, req.tool)).value,
        lookup: exec.lookup ? async (key, since) => (await exec.lookup!(spec, req.args, key, since, execCtx))?.value ?? null : undefined,
      },
    );
    value = r.receipt;
    action = { id: r.actionId, reused: r.reused };
  }

  const validOut = validator(spec.output_schema);
  if (!validOut(value)) {
    throw new AzhiError(ErrorClass.contractViolation, `${req.tool} returned output that does not match its schema: ${ajv.errorsText(validOut.errors)}`);
  }

  // Raw payloads are always kept as artifacts; downstream nodes get the projection.
  const raw = ctx.artifacts.put(JSON.stringify(value));
  await ctx.pool.query(`INSERT INTO artifacts(workspace_id, hash, size, media_type) VALUES ($1,$2,$3,'application/json') ON CONFLICT DO NOTHING`, [
    req.workspaceId,
    raw.hash,
    raw.size,
  ]);
  const observation: Observation = {
    tool: req.tool,
    source: spec.source ?? spec.id.split('.')[0]!,
    observed_at: new Date().toISOString(),
    query_hash: `sha256:${sha256(canonicalJson({ tool: req.tool, args: req.args }))}`,
    ...(etag ? { etag } : {}),
    artifact: raw.hash,
  };
  let output = project(value, req.project);
  if (byteSize(output) > ARTIFACT_THRESHOLD_BYTES) output = asArtifact(ctx, req.workspaceId, output);
  return { output, observation, ...(action ? { action } : {}) };
}

export function asArtifact(ctx: AppContext, workspaceId: string, value: unknown): ArtifactHandle {
  const a = ctx.artifacts.put(JSON.stringify(value));
  void ctx.pool.query(`INSERT INTO artifacts(workspace_id, hash, size, media_type) VALUES ($1,$2,$3,'application/json') ON CONFLICT DO NOTHING`, [workspaceId, a.hash, a.size]);
  return { $artifact: { hash: a.hash, size: a.size, media_type: 'application/json' } };
}

function targetOf(spec: ToolSpec, args: Record<string, unknown>): Record<string, unknown> {
  if (spec.id === 'slack.post-message') return { channel: args.channel };
  return {};
}

function mapSendError(err: unknown): never {
  if (err instanceof SendError) throw new AzhiError(err.errorClass, err.message);
  throw err;
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SendError(`${what} timed out after ${ms} ms`, false)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
