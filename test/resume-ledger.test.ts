import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { callTool } from '../src/gateway/gateway.js';
import { actionIdFor } from '../src/gateway/ledger.js';
import { AzhiError, ErrorClass } from '../src/lib/errors.js';
import { bootstrapLocal } from '../src/api/auth.js';
import { registerTool } from '../src/server/catalog.js';
import { createContext } from '../src/server/context.js';
import { createRun, resumeRun } from '../src/server/runs.js';
import { setSecret } from '../src/server/secrets.js';
import { resolveVersion, uploadPackage } from '../src/server/workflows.js';
import { startFakeSlack } from '../src/testing/fake-slack.js';

/**
 * A resumed run is a new run, so its action IDs differ from those of the run it continues. These tests drive the
 * real `resumeRun` and `callTool` against fake targets (no Temporal: the interpreter only chooses which step runs):
 * a write is applied, its receipt is lost, the run fails, and the resumed run reaches the same write.
 */
const POST = { node: 'post', tool: 'acme.post@1', args: { channel: 'C1', text: 'hello' } };
const IDEMPOTENT = { node: 'idempotent', tool: 'acme.idempotent@1', args: { n: 1 } };
const UNSAFE = { node: 'unsafe', tool: 'acme.unsafe@1', args: { n: 1 } };
type Write = typeof POST | typeof IDEMPOTENT | typeof UNSAFE;

const workflow = `schema_version: "2.0"
id: resume-ledger
nodes:
  - id: post
    type: tool
    tool: ${POST.tool}
    arguments: {channel: C1, text: hello}
  - id: idempotent
    type: tool
    tool: ${IDEMPOTENT.tool}
    arguments: {n: 1}
  - id: unsafe
    type: tool
    tool: ${UNSAFE.tool}
    arguments: {n: 1}
`;

const object = { type: 'object' } as const;
const httpTool = (name: string, effect: 'write-idempotent' | 'write-unsafe', url: string) => ({
  id: `acme.${name}`,
  version: 1,
  description: name,
  effect,
  timeout: '100ms',
  transport: { kind: 'http', method: 'POST', url: `${url}/${name}` },
  input_schema: object,
  output_schema: object,
});

describe('resuming a run whose write has an unknown outcome', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'azhi-resume-ledger-'));
  const ctx = createContext({ databaseUrl: 'pglite://memory', dataDir });
  const WS = () => workspace;
  let workspace: string;
  let versionId: string;
  let slack: Awaited<ReturnType<typeof startFakeSlack>>;
  let target: http.Server;
  /** What reached the HTTP target, with the idempotency key each request carried. */
  const received: Array<{ path: string; key: string }> = [];
  /** While set, the target applies a request and answers too late: the sender times out with no receipt. */
  const lose = { receipt: false };

  beforeAll(async () => {
    process.env.AZHI_EGRESS_ALLOW = '127.0.0.1';
    await migrate(ctx.pool);
    await bootstrapLocal(ctx);
    workspace = (await ctx.pool.query(`SELECT id FROM workspaces LIMIT 1`)).rows[0].id;
    slack = await startFakeSlack();
    ctx.settings.slackApiUrl = slack.url;
    target = http.createServer(async (req, res) => {
      for await (const _ of req);
      received.push({ path: req.url!, key: String(req.headers['idempotency-key']) });
      if (lose.receipt) await new Promise((r) => setTimeout(r, 300));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
    await setSecret(ctx, workspace, 'slack-bot-token', 'xoxb-test', 'test');
    await registerTool(
      ctx,
      workspace,
      {
        id: 'acme.post',
        version: 1,
        description: 'post',
        effect: 'write-dedupable',
        credential: 'slack-bot-token',
        timeout: '100ms',
        transport: { kind: 'builtin', name: 'slack.post-message' },
        input_schema: object,
        output_schema: object,
      } as never,
      'test',
    );
    await registerTool(ctx, workspace, httpTool('idempotent', 'write-idempotent', url) as never, 'test');
    await registerTool(ctx, workspace, httpTool('unsafe', 'write-unsafe', url) as never, 'test');
    const up = await uploadPackage(ctx, workspace, { workflow: 'workflow.yaml', files: { 'workflow.yaml': Buffer.from(workflow).toString('base64') } }, 'test');
    expect(up.ok, JSON.stringify(up.diagnostics)).toBe(true);
    if (up.ok) versionId = up.version.id;
  });
  afterAll(async () => {
    delete process.env.AZHI_EGRESS_ALLOW;
    await new Promise((r) => setTimeout(r, 350)); // let the late answers go out, so the servers can close
    await slack?.close();
    await new Promise((r) => target?.close(r));
  });
  beforeEach(() => {
    received.length = 0;
    slack.messages.length = 0;
    slack.state.postDelayMs = 0;
    lose.receipt = false;
  });

  const newRun = async () => {
    const version = (await resolveVersion(ctx, WS(), versionId))!;
    return (await createRun(ctx, WS(), { version, inputs: {}, trigger: 'api', createdBy: 'test', interpreterBuild: 'test' })).runId;
  };
  const call = (runId: string, w: Write, attempt = 1) => callTool(ctx, { workspaceId: WS(), runId, nodeId: w.node, attempt, tool: w.tool, args: w.args, allowed: [w.tool] });
  const fail = (runId: string) => ctx.pool.query(`UPDATE runs SET state='failed' WHERE id=$1`, [runId]);
  /** Ends the run and starts the one that continues it, through the same function the API uses. */
  const resume = async (runId: string) => {
    await fail(runId);
    return (await resumeRun(ctx, WS(), runId, 'test', 'test')).runId!;
  };
  const opId = (runId: string, w: Write) => actionIdFor(runId, w.node, { tool: w.tool, effect: 'write-unsafe', operation: w.args });
  const action = async (runId: string, w: Write) => (await ctx.pool.query(`SELECT id, state, idempotency_key, receipt FROM actions WHERE id=$1`, [opId(runId, w)])).rows[0];
  /** The send reaches the target and the answer never comes back in time. */
  const sendAndLoseReceipt = async (runId: string, w: Write) => {
    lose.receipt = true;
    slack.state.postDelayMs = 300;
    await expect(call(runId, w)).rejects.toThrow(/timed out/);
    lose.receipt = false;
    slack.state.postDelayMs = 0;
    expect((await action(runId, w)).state).toBe('outcome_unknown');
  };
  const dedupeKeys = () => slack.messages.map((m) => m.metadata?.event_payload?.action_id);

  describe('write-dedupable', () => {
    it.each(['outcome_unknown', 'dispatched'])('finds the write of a run left %s, hours later, and does not send it again', async (left) => {
      const a = await newRun();
      await sendAndLoseReceipt(a, POST);
      // `dispatched` is what a killed process leaves behind. The resume comes well after the lookup's one minute of slack.
      await ctx.pool.query(`UPDATE actions SET state=$2, created_at = now() - interval '2 hours' WHERE id=$1`, [opId(a, POST), left]);
      const sent = slack.messages[0]!;
      sent.ts = `${Math.floor(Date.now() / 1000) - 7200}.000001`;

      const b = await resume(a);
      const r = await call(b, POST);

      expect(slack.messages).toHaveLength(1);
      expect(r.output).toMatchObject({ ts: sent.ts });
      expect(r.action).toEqual({ id: opId(b, POST), reused: true });
      // The resumed run keeps its own action; it carries the key the first send went out under.
      expect(await action(b, POST)).toMatchObject({ state: 'confirmed', idempotency_key: opId(a, POST) });
    });

    it('resends under the original key when the target has no record of the write', async () => {
      const a = await newRun();
      await sendAndLoseReceipt(a, POST);
      slack.messages.length = 0; // the request never landed
      const b = await resume(a);
      const r = await call(b, POST);
      expect(slack.messages).toHaveLength(1);
      expect(r.action?.reused).toBe(false);
      expect(dedupeKeys()).toEqual([opId(a, POST)]);
    });

    it('follows a chain of resumes back to the original send', async () => {
      const a = await newRun();
      await sendAndLoseReceipt(a, POST);
      slack.messages.length = 0;
      const b = await resume(a);
      await sendAndLoseReceipt(b, POST); // the second send lands, under the first key, and loses its receipt too
      expect(dedupeKeys()).toEqual([opId(a, POST)]);
      const c = await resume(b);
      const r = await call(c, POST);
      expect(slack.messages).toHaveLength(1);
      expect(r.action?.reused).toBe(true);
      expect((await action(c, POST)).idempotency_key).toBe(opId(a, POST));
    });

    it('looks through a resume that never reached the step', async () => {
      const a = await newRun();
      await sendAndLoseReceipt(a, POST);
      const b = await resume(a);
      const c = await resume(b);
      const r = await call(c, POST);
      expect(slack.messages).toHaveLength(1);
      expect(r.action?.reused).toBe(true);
    });

    it('still finds the write after an intermediate run confirmed it and failed later', async () => {
      const a = await newRun();
      await sendAndLoseReceipt(a, POST);
      const b = await resume(a);
      expect((await call(b, POST)).action?.reused).toBe(true);
      const c = await resume(b);
      expect((await call(c, POST)).action?.reused).toBe(true);
      expect(slack.messages).toHaveLength(1);
    });
  });

  describe('write-idempotent', () => {
    it.each(['outcome_unknown', 'dispatched'])('resends a write left %s under the original key, so the target can drop it', async (left) => {
      const a = await newRun();
      await sendAndLoseReceipt(a, IDEMPOTENT);
      await ctx.pool.query(`UPDATE actions SET state=$2 WHERE id=$1`, [opId(a, IDEMPOTENT), left]);
      const b = await resume(a);
      await call(b, IDEMPOTENT);
      expect(received.map((r) => r.key)).toEqual([opId(a, IDEMPOTENT), opId(a, IDEMPOTENT)]);
      expect((await action(b, IDEMPOTENT)).state).toBe('confirmed');
    });
  });

  describe('write-unsafe', () => {
    it.each(['outcome_unknown', 'dispatched'])('stops for an operator instead of resending a write left %s', async (left) => {
      const a = await newRun();
      await sendAndLoseReceipt(a, UNSAFE);
      await ctx.pool.query(`UPDATE actions SET state=$2 WHERE id=$1`, [opId(a, UNSAFE), left]);
      const b = await resume(a);
      const err = await call(b, UNSAFE).catch((e) => e);
      expect(err).toBeInstanceOf(AzhiError);
      expect(err.errorClass).toBe(ErrorClass.needsOperator);
      expect(err.details).toEqual({ action_id: opId(a, UNSAFE), run_id: a });
      expect(received).toHaveLength(1);
      expect(await action(b, UNSAFE)).toBeUndefined();
    });

    it('goes ahead once the earlier action has a settled state', async () => {
      const a = await newRun();
      await sendAndLoseReceipt(a, UNSAFE);
      const b = await resume(a);
      await expect(call(b, UNSAFE)).rejects.toThrow(/operator/);
      // The run's own ledger row is what an operator changes after checking the target.
      await ctx.pool.query(`UPDATE actions SET state='failed' WHERE id=$1`, [opId(a, UNSAFE)]);
      await call(b, UNSAFE);
      expect(received).toHaveLength(2);
      expect(received[1]!.key).toBe(opId(b, UNSAFE));
    });
  });

  describe('what stays as it was', () => {
    it('leaves action IDs and keys alone in a run that was not resumed', async () => {
      const a = await newRun();
      const r = await call(a, IDEMPOTENT);
      expect(r.action?.id).toBe(opId(a, IDEMPOTENT));
      expect(received.map((x) => x.key)).toEqual([opId(a, IDEMPOTENT)]);
    });

    it('keeps retries within one run on the same action', async () => {
      const a = await newRun();
      await sendAndLoseReceipt(a, POST);
      const r = await call(a, POST, 2);
      expect(r.action).toEqual({ id: opId(a, POST), reused: true });
      expect(slack.messages).toHaveLength(1);
    });

    it('does not link a new run of the same inputs to an earlier one', async () => {
      const a = await newRun();
      await sendAndLoseReceipt(a, UNSAFE);
      await fail(a);
      await call(await newRun(), UNSAFE);
      expect(received).toHaveLength(2);
    });

    it('takes a fresh key after a definite failure, since nothing was applied', async () => {
      const a = await newRun();
      await sendAndLoseReceipt(a, IDEMPOTENT);
      await ctx.pool.query(`UPDATE actions SET state='failed' WHERE id=$1`, [opId(a, IDEMPOTENT)]);
      const b = await resume(a);
      await call(b, IDEMPOTENT);
      expect(received[1]!.key).toBe(opId(b, IDEMPOTENT));
    });
  });

  /** Known gaps, pinned so a change to them is a decision. See "Across resumes" in the ledger concept page. */
  describe('writes a resume still repeats', () => {
    it('a write whose arguments changed is a different action', async () => {
      const a = await newRun();
      await sendAndLoseReceipt(a, POST);
      const b = await resume(a);
      await call(b, { ...POST, args: { channel: 'C1', text: 'hello again' } } as Write);
      expect(slack.messages).toHaveLength(2);
    });

    it('a write confirmed in a step that failed afterwards runs again', async () => {
      const a = await newRun();
      await call(a, POST);
      const b = await resume(a);
      await call(b, POST);
      expect(slack.messages).toHaveLength(2);
    });
  });
});
