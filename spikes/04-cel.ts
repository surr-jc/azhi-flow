/**
 * Spike 4: CEL in TypeScript.
 *
 * Questions:
 *  - Can one evaluator serve both the compiler (type-check only) and the runtime (evaluate)?
 *  - Can a `ref` be type-checked against a JSON Schema by mapping schema types to CEL types?
 *  - How is `now` pinned so Temporal replay is deterministic?
 *
 * Run: npx tsx spikes/04-cel.ts
 */
import { Environment } from '@marcbachmann/cel-js';
import assert from 'node:assert/strict';

const results: Array<[string, boolean, string]> = [];
function check(name: string, fn: () => string | void) {
  try {
    results.push([name, true, fn() ?? '']);
  } catch (err) {
    results.push([name, false, (err as Error).message.split('\n')[0] ?? '']);
  }
}

// One environment definition, built by a function both compiler and runtime call.
function makeEnv() {
  return new Environment({ unlistedVariablesAreDyn: false, homogeneousAggregateLiterals: false })
    .registerVariable('inputs', 'map')
    .registerVariable('nodes', 'map')
    .registerVariable('now', 'google.protobuf.Timestamp');
}

check('compile-time check accepts valid expression', () => {
  const r = makeEnv().check("now - duration('168h')");
  assert.equal(r.valid, true);
  return `type=${r.type}`;
});

check('compile-time check rejects type error without evaluating', () => {
  const r = makeEnv().check("1 + 'a'");
  assert.equal(r.valid, false);
  return r.error?.message.split('\n')[0];
});

check('compile-time check rejects unknown variable', () => {
  const r = makeEnv().check('secrets.token');
  assert.equal(r.valid, false);
  return r.error?.message.split('\n')[0];
});

check('`now` pinned from the run snapshot gives identical results on replay', () => {
  const pinned = new Date('2026-10-05T02:30:00Z'); // scheduled occurrence time, not wall clock
  const a = makeEnv().evaluate("now - duration('168h')", { inputs: {}, nodes: {}, now: pinned });
  const b = makeEnv().evaluate("now - duration('168h')", { inputs: {}, nodes: {}, now: pinned });
  assert.equal(String(a), String(b));
  return (a as Date).toISOString();
});

check('map expressions build node inputs from upstream outputs', () => {
  const v = makeEnv().evaluate("{'metrics': nodes.metrics.output, 'n': 1}", {
    inputs: {},
    nodes: { metrics: { output: { pass_rate: 0.97 } } },
    now: new Date(),
  }) as Record<string, unknown>;
  assert.deepEqual(v.metrics, { pass_rate: 0.97 });
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x));
});

check('typed variables from JSON Schema catch field typos at compile time', () => {
  const env = new Environment({ homogeneousAggregateLiterals: false }).registerVariable({
    name: 'metrics',
    schema: { pass_rate: 'double', flake_rate: 'double', runs: 'int' },
  });
  const ok = env.check('metrics.pass_rate > 0.9');
  const bad = env.check('metrics.pass_rte > 0.9');
  assert.equal(ok.valid, true);
  assert.equal(bad.valid, false);
  return bad.error?.message.split('\n')[0];
});

check('CEL guard on a notify destination (taint rule gate 2)', () => {
  const env = new Environment().registerVariable('args', 'map').registerVariable('config', 'map');
  const guard = "args.channel == config.team_channel && size(args.text) <= 3000";
  assert.equal(env.evaluate(guard, { args: { channel: 'C1', text: 'hi' }, config: { team_channel: 'C1' } }), true);
  assert.equal(env.evaluate(guard, { args: { channel: 'C9', text: 'hi' }, config: { team_channel: 'C1' } }), false);
});

check('integers come back as BigInt and must be normalised to JSON numbers', () => {
  const v = makeEnv().evaluate('1 + 2', { inputs: {}, nodes: {}, now: new Date() });
  assert.equal(typeof v, 'bigint');
  return 'normalise at the evaluator boundary';
});

for (const [name, ok, note] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  (${note})` : ''}`);
process.exitCode = results.every(([, ok]) => ok) ? 0 : 1;
