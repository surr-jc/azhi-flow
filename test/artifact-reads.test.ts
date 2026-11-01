import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { artifactReads } from '../src/runtime/values.js';
import { startHarness, temporalAvailable, uploadDir, waitForRun, type Harness } from './helpers/harness.js';

/**
 * An output over the artifact threshold is stored and travels as a handle. Passing it on whole needs
 * nothing; reading a field of it from CEL (`nodes.big.output.summary`) is resolved next to the store.
 */
const handle = { output: { $artifact: { hash: 'sha256:x', size: 1, media_type: 'application/json' } } };
const nodes = { big: handle, small: { output: { a: 1 } } };

describe('which stored outputs a value reads into', () => {
  it('finds a field read, in a map, a cel expression and a nested value', () => {
    expect(artifactReads({ map: "{'s': nodes.big.output.summary}" }, nodes)).toEqual(['big']);
    expect(artifactReads({ cel: "has(nodes.big.output.x) ? 1 : 2" }, nodes)).toEqual(['big']);
    expect(artifactReads({ k: [{ map: "{'a': nodes.big.output['summary']}" }] } as never, nodes)).toEqual(['big']);
  });
  it('leaves an output passed on whole, an inline output and a plain ref alone', () => {
    expect(artifactReads({ map: "{'change': nodes.big.output}" }, nodes)).toEqual([]);
    expect(artifactReads({ map: "{'a': nodes.small.output.a}" }, nodes)).toEqual([]);
    expect(artifactReads({ ref: 'nodes.big.output.summary' }, nodes)).toEqual([]);
  });
});

const BIG = 'import json\nprint(json.dumps({"summary": "kept", "blob": "x" * 300000}))\n';
const PICK = 'import json, sys\nd = json.load(sys.stdin)\nprint(json.dumps({"got": d["summary"]}))\n';
const workflow = `schema_version: "2.0"
id: big-output
nodes:
  - id: big
    type: script
    runtime: python
    entrypoint: scripts/big.py
    output_schema: {type: object, properties: {summary: {type: string}}, required: [summary]}
  - id: pick
    type: script
    runtime: python
    entrypoint: scripts/pick.py
    input: {map: "{'summary': nodes.big.output.summary}"}
    output_schema: {type: object, properties: {got: {type: string}}, required: [got]}
  - id: route
    type: condition
    expression: "nodes.big.output.summary == 'kept' ? 'kept' : 'lost'"
    routes: {kept: [], lost: []}
    default: lost
`;

const up = await temporalAvailable();

describe.skipIf(!up)('a step that reads a field of a stored output', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => h?.stop());

  it('gets the field, not a handle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'azhi-big-'));
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'workflow.yaml'), workflow);
    writeFileSync(join(dir, 'scripts/big.py'), BIG);
    writeFileSync(join(dir, 'scripts/pick.py'), PICK);
    const v = await uploadDir(h.api, dir);
    expect(v.ok).toBe(true);
    const { run_id } = await h.api.post<{ run_id: string }>('/v1/runs', { version: v.version.id, inputs: {} });
    const d = await waitForRun(h.api, run_id);
    expect(d.run.error).toBeNull();
    expect(d.run.state).toBe('succeeded');
    expect(d.attempts.find((a: any) => a.node_id === 'big')?.output).toHaveProperty('$artifact');
    expect(d.attempts.find((a: any) => a.node_id === 'pick')?.output).toEqual({ got: 'kept' });
    // A condition reads into the stored output too.
    expect(d.attempts.find((a: any) => a.node_id === 'route')?.output).toEqual({ route: 'kept' });
  });
});
