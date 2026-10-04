import { describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { packageFromFiles } from '../src/definition/package.js';
import { staticCatalog, type ToolSpec } from '../src/gateway/types.js';

const tool = (id: string, effect: ToolSpec['effect'], extra: Partial<ToolSpec> = {}): ToolSpec => ({
  id,
  version: 1,
  description: id,
  effect,
  transport: { kind: 'builtin', name: 'fixture' },
  input_schema: { type: 'object' },
  output_schema: { type: 'object', properties: { items: { type: 'array' } } },
  ...extra,
});
const catalog = staticCatalog([
  tool('ci.list-runs', 'read'),
  tool('docs.lookup', 'read', { output_trusted: true }),
  tool('jira.create', 'write-dedupable'),
  tool('slack.thread-reply', 'write-dedupable', { safe_for_tainted: true }),
]);

const pkgFiles = new Map([
  ['profiles/analyst@1.yaml', Buffer.from('instructions: analyse\n')],
  ['t.md', Buffer.from('{{summary}}')],
  ['schemas/analysis.json', Buffer.from('{"type":"object","properties":{"summary":{"type":"string"}}}')],
]);

function build(nodes: string) {
  const text = `schema_version: "2.0"
id: t
config: {channel: C1}
nodes:
  - id: fetch
    type: tool
    tool: ci.list-runs@1
  - id: analyse
    type: agent
    profile: analyst@1
    input: {ref: nodes.fetch.output}
    output_schema: schemas/analysis.json
${nodes}`;
  const files = new Map(pkgFiles);
  files.set('workflow.yaml', Buffer.from(text));
  const loaded = loadDefinitionText(text);
  if (!loaded.definition) throw new Error(JSON.stringify(loaded.diagnostics));
  return compile(loaded.definition, { catalog, pkg: packageFromFiles('workflow.yaml', files) });
}

const errors = (r: ReturnType<typeof build>) => r.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}:${d.node}`);

describe('taint rule', () => {
  it('rejects an ungated notify after an agent that read untrusted tool output', () => {
    const r = build(`  - id: post
    type: notify
    channel: slack
    destination: {ref: config.channel}
    message: {ref: nodes.analyse.output.summary}
`);
    expect(errors(r)).toEqual(['tainted_write_ungated:post']);
    expect(r.diagnostics[0]!.message).toContain('analyse -> post');
  });

  it('accepts the same write with a CEL guard and shows the path in the plan', () => {
    const r = build(`  - id: post
    type: notify
    channel: slack
    destination: {ref: config.channel}
    message: {ref: nodes.analyse.output.summary}
    guard: "args.channel == config.channel"
`);
    expect(errors(r)).toEqual([]);
    expect(r.plan!.taint.tainted.analyse).toMatch(/reads fetch/);
    expect(r.plan!.taint.paths).toEqual([{ agent: 'analyse', write: 'post', path: ['analyse', 'post'], gate: 'guard' }]);
  });

  it('accepts writes behind an approval node', () => {
    const r = build(`  - id: review
    type: approval
    payload: {ref: nodes.analyse.output}
  - id: post
    type: notify
    channel: slack
    destination: {ref: config.channel}
    message: {ref: nodes.review.output.decision}
`);
    expect(errors(r)).toEqual([]);
    expect(r.plan!.taint.paths[0]).toMatchObject({ write: 'post', gate: 'approval' });
  });

  it('follows taint through deterministic nodes between agent and write', () => {
    const r = build(`  - id: report
    type: report
    template: t.md
    input: {ref: nodes.analyse.output}
  - id: post
    type: notify
    channel: slack
    destination: {ref: config.channel}
    message: {ref: nodes.report.output.summary}
`);
    expect(errors(r)).toContain('tainted_write_ungated:post');
  });

  it('rejects a tainted agent that may call a write tool not marked safe-for-tainted', () => {
    const r = build(`  - id: triage
    type: agent
    profile: analyst@1
    input: {ref: nodes.fetch.output}
    tools: [jira.create@1, slack.thread-reply@1]
    output_schema: schemas/analysis.json
`);
    expect(errors(r)).toEqual(['tainted_write_ungated:triage']);
    expect(r.diagnostics.find((d) => d.code === 'tainted_write_ungated')!.message).toContain('jira.create@1');
  });

  it('does not taint an agent whose inputs and tools are trusted', () => {
    const text = `schema_version: "2.0"
id: t
nodes:
  - id: docs
    type: tool
    tool: docs.lookup@1
  - id: analyse
    type: agent
    profile: analyst@1
    input: {ref: nodes.docs.output}
    tools: [jira.create@1]
    output_schema: schemas/analysis.json
`;
    const files = new Map(pkgFiles);
    files.set('workflow.yaml', Buffer.from(text));
    const r = compile(loadDefinitionText(text).definition!, { catalog, pkg: packageFromFiles('workflow.yaml', files) });
    expect(r.ok).toBe(true);
    expect(r.plan!.taint.tainted).toEqual({});
  });

  it('a deterministic workflow with no agent has no taint paths', () => {
    const text = `schema_version: "2.0"
id: t
config: {channel: C1}
nodes:
  - id: fetch
    type: tool
    tool: ci.list-runs@1
  - id: post
    type: notify
    channel: slack
    destination: {ref: config.channel}
    message: {cel: "string(size(nodes.fetch.output.items))"}
`;
    const r = compile(loadDefinitionText(text).definition!, { catalog });
    expect(r.ok).toBe(true);
    expect(r.plan!.taint.paths).toEqual([]);
  });
});
