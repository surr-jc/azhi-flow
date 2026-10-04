import { describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { packageFromFiles } from '../src/definition/package.js';
import { staticCatalog, type ToolSpec } from '../src/gateway/types.js';

const ciListRuns: ToolSpec = {
  id: 'ci.list-runs',
  version: 1,
  description: 'List CI runs',
  effect: 'read',
  transport: { kind: 'builtin', name: 'fixture' },
  input_schema: {
    type: 'object',
    properties: { team: { type: 'string' }, since: { type: 'string' } },
    required: ['team'],
    additionalProperties: false,
  },
  output_schema: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string' },
        duration_s: { type: 'number' },
        test_failures: { type: 'integer' },
        log_url: { type: 'string' },
      },
    },
  },
};
const catalog = staticCatalog([ciListRuns]);

const base = `
schema_version: "2.0"
id: weekly-quality-report
trigger:
  schedule: {cron: "0 8 * * MON", timezone: "Asia/Kolkata"}
inputs:
  type: object
  properties: {team: {type: string}}
  required: [team]
config:
  team_channel: C123
nodes:
  - id: fetch
    type: tool
    tool: ci.list-runs@1
    arguments: {team: {ref: inputs.team}, since: {cel: "string(now - duration('168h'))"}}
    project: [id, status, duration_s, test_failures]
  - id: metrics
    type: script
    runtime: python
    entrypoint: scripts/metrics.py
    input: {ref: nodes.fetch.output}
    output_schema: schemas/metrics.json
  - id: report
    type: report
    template: templates/weekly.md
    input: {map: "{'metrics': nodes.metrics.output}"}
  - id: post
    type: notify
    channel: slack
    destination: {ref: config.team_channel}
    message: {ref: nodes.report.output.summary}
`;

const pkg = packageFromFiles(
  'workflow.yaml',
  new Map([
    ['workflow.yaml', Buffer.from(base)],
    ['scripts/metrics.py', Buffer.from('print(1)')],
    ['templates/weekly.md', Buffer.from('# {{ metrics.pass_rate }}')],
    ['schemas/metrics.json', Buffer.from(JSON.stringify({ type: 'object', properties: { pass_rate: { type: 'number' } } }))],
  ]),
);

function compileText(text: string, withPkg = true) {
  const loaded = loadDefinitionText(text);
  if (!loaded.definition) return { ok: false, diagnostics: loaded.diagnostics };
  return compile(loaded.definition, { catalog, pkg: withPkg ? pkg : undefined });
}

const codes = (r: { diagnostics: Array<{ code: string; severity: string }> }) => r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);

describe('compiler', () => {
  it('compiles the tool -> script -> report -> notify workflow in dependency order', () => {
    const r = compileText(base);
    expect(codes(r)).toEqual([]);
    expect(r.plan!.nodes.map((n) => n.id)).toEqual(['fetch', 'metrics', 'report', 'post']);
    expect(r.plan!.nodes.find((n) => n.id === 'post')!.deps).toEqual(['report']);
    expect(r.plan!.nodes[0]!.tool).toMatchObject({ ref: 'ci.list-runs@1', effect: 'read', outputTrusted: false });
    expect(r.plan!.packageHash).toMatch(/^sha256:/);
  });

  it('projects tool output schemas to declared fields', () => {
    const r = compileText(base);
    const items = (r.plan!.nodes[0]!.outputSchema as any).items;
    expect(Object.keys(items.properties)).toEqual(['id', 'status', 'duration_s', 'test_failures']);
  });

  it('rejects refs to fields that do not exist in the producer schema', () => {
    const r = compileText(base.replace('nodes.report.output.summary', 'nodes.report.output.sumary'));
    expect(codes(r)).toContain('ref_type');
  });

  it('rejects projection of a field the tool does not return', () => {
    const r = compileText(base.replace('project: [id, status', 'project: [id, colour'));
    expect(codes(r)).toContain('projection_unknown_field');
  });

  it('rejects unknown tools, missing and mistyped arguments', () => {
    expect(codes(compileText(base.replace('ci.list-runs@1', 'ci.list-runs@2')))).toContain('unknown_tool');
    expect(codes(compileText(base.replace('team: {ref: inputs.team}, ', '')))).toContain('missing_argument');
    expect(codes(compileText(base.replace('team: {ref: inputs.team}', 'team: 42')))).toContain('argument_type');
  });

  it('rejects invalid CEL and unknown node references', () => {
    expect(codes(compileText(base.replace("string(now - duration('168h'))", "now - 'x' +")))).toContain('invalid_cel');
    expect(codes(compileText(base.replace("{'metrics': nodes.metrics.output}", "{'metrics': nodes.metricz.output}")))).toContain('unknown_ref_node');
  });

  it('rejects cycles', () => {
    const r = compileText(base.replace('input: {ref: nodes.fetch.output}', 'input: {ref: nodes.fetch.output}\n    depends_on: [post]'));
    expect(codes(r)).toEqual(['cycle']);
  });

  it('rejects files missing from the package', () => {
    expect(codes(compileText(base.replace('scripts/metrics.py', 'scripts/missing.py')))).toContain('missing_file');
  });

  it('rejects invalid schedules', () => {
    expect(codes(compileText(base.replace('Asia/Kolkata', 'Mars/Olympus')))).toContain('invalid_timezone');
    expect(codes(compileText(base.replace('0 8 * * MON', 'every monday')))).toContain('invalid_cron');
  });

  it('rejects node types not available in this release', () => {
    const r = compileText(base + '  - id: again\n    type: loop\n    max_iterations: 3\n    exit: "true"\n');
    expect(codes(r)).toContain('unsupported_in_release');
  });

  it('reports schema errors with the node id', () => {
    const loaded = loadDefinitionText(base.replace('runtime: python', 'runtime: ruby'));
    expect(loaded.diagnostics[0]).toMatchObject({ code: 'schema', node: 'metrics' });
  });

  it('warns rather than fails when no tool catalog is available', () => {
    const loaded = loadDefinitionText(base);
    const r = compile(loaded.definition!, {});
    expect(r.ok).toBe(true);
    expect(r.diagnostics.map((d) => d.code)).toContain('catalog_unavailable');
  });

  it('wires condition routes as dependencies', () => {
    const text = `${base}  - id: gate
    type: condition
    expression: "nodes.fetch.output.size() > 0 ? 'some' : 'none'"
    routes: {some: [extra]}
    default: some
  - id: extra
    type: report
    template: templates/weekly.md
`;
    const r = compileText(text);
    expect(codes(r)).toEqual([]);
    const extra = r.plan!.nodes.find((n) => n.id === 'extra')!;
    expect(extra.deps).toEqual(['gate']);
    expect(extra.route).toEqual({ condition: 'gate', route: 'some' });
  });
});
