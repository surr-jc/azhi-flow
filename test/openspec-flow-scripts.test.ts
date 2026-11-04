import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** The OpenSpec flow's scripts, run the way the worker runs one: JSON in on stdin, JSON out. */
const DIR = 'examples/openspec-flow/scripts';
const python = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3');

function run(script: string, input: unknown) {
  // Windows' default Python reads piped text in a legacy code page, so the test leaves its UTF-8 settings unset.
  const env = { ...process.env, PYTHONUTF8: '', PYTHONIOENCODING: '' };
  const out = execFileSync(python!, [`${DIR}/${script}`], { input: Buffer.from(JSON.stringify(input), 'utf8'), env, maxBuffer: 1 << 24 });
  return JSON.parse(out.toString('utf8'));
}

const file = (path: string, content: string, status = 'added') => ({ path, status, mode: '100644', content, additions: 1, deletions: 0 });
const req = (name: string, extra = '') => `### Requirement: ${name}\nThe system SHALL ${name.toLowerCase()}.\n\n#### Scenario: ${name} works\n- **WHEN** it is asked\n- **THEN** it ${extra || 'answers'}\n`;
const WHY = '## Why\nCarts cannot take a discount code, so shoppers leave at checkout and support gets the requests.\n\n## What Changes\n- Add a discount code field\n';
const TASKS = '## 1. Cart\n- [x] 1.1 Add the field\n';
const scan = { has_openspec: true, capabilities: [{ name: 'cart', requirements: ['Totals', 'Old Name', 'Gift Wrap'] }], active_changes: [], rules: [] };

const change = (id: string, delta: string, extra: ReturnType<typeof file>[] = []) => [
  file(`openspec/changes/${id}/proposal.md`, WHY),
  file(`openspec/changes/${id}/tasks.md`, TASKS),
  file(`openspec/changes/${id}/specs/cart/spec.md`, delta),
  ...extra,
];
const check = (files: unknown[], s: unknown = scan) => run('spec_check.py', { mode: 'change', change_id: 'add-discount', files, scan: s });

describe('OpenSpec flow: pick_change_id.py', () => {
  it('builds the id only from [a-z0-9-], however hostile the title', () => {
    const r = run('pick_change_id.py', { key: 'acme/shop#42', title: 'Add `rm -rf /` $(curl x) discount!' });
    expect(r.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(r.id.length).toBeLessThanOrEqual(48);
    expect(r.change_dir).toBe(`openspec/changes/${r.id}`);
    expect(r.archive_dir).toBe(`openspec/changes/archive/${r.date}-${r.id}`);
  });
});

describe('OpenSpec flow: spec_check.py, change mode', () => {
  it('accepts a well-formed change with every delta operation', () => {
    const delta = `## ADDED Requirements\n${req('Discount Code')}\n## MODIFIED Requirements\n${req('Totals')}\n## REMOVED Requirements\n### Requirement: Gift Wrap\n**Reason**: retired\n**Migration**: none\n\n## RENAMED Requirements\n- FROM: \`### Requirement: Old Name\`\n- TO: \`### Requirement: New Name\`\n`;
    const r = check(change('add-discount', delta));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.deltas.map((d: { op: string }) => d.op).sort()).toEqual(['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED']);
  });

  it('rejects a requirement without SHALL/MUST, without a scenario, and with a three-hash scenario', () => {
    const delta = '## ADDED Requirements\n### Requirement: A\nIt does things.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n\n### Requirement: B\nThe system SHALL b.\n\n### Scenario: wrong level\n- **WHEN** x\n- **THEN** y\n';
    const r = check(change('add-discount', delta));
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/'A' has no SHALL or MUST/);
    expect(r.errors.join('\n')).toMatch(/'B' has no `#### Scenario:`/);
    expect(r.errors.join('\n')).toMatch(/not a scenario header/);
  });

  it('rejects a MODIFIED or REMOVED target that does not exist, a duplicate ADDED and a bad RENAME', () => {
    const delta = `## ADDED Requirements\n${req('Totals')}\n## MODIFIED Requirements\n${req('Missing One')}\n## REMOVED Requirements\n### Requirement: Nope\n**Reason**: r\n\n## RENAMED Requirements\n- FROM: \`### Requirement: Absent\`\n- TO: \`### Requirement: Totals\`\n`;
    const e = check(change('add-discount', delta)).errors.join('\n');
    expect(e).toMatch(/ADDED 'Totals' already exists/);
    expect(e).toMatch(/MODIFIED 'Missing One' matches no current requirement/);
    expect(e).toMatch(/REMOVED 'Nope' matches no current requirement/);
    expect(e).toMatch(/RENAMED FROM 'Absent'/);
    expect(e).toMatch(/RENAMED TO 'Totals' already exists/);
  });

  it('only allows ADDED for a capability with no current spec', () => {
    const files = [...change('add-discount', '').slice(0, 2), file('openspec/changes/add-discount/specs/promo/spec.md', `## MODIFIED Requirements\n${req('X')}`)];
    expect(check(files).errors.join('\n')).toMatch(/capability 'promo' has no current spec/);
  });

  it('rejects a short Why, missing tasks and writes outside the change folder', () => {
    const files = [
      file('openspec/changes/add-discount/proposal.md', '## Why\nshort\n\n## What Changes\n- x\n'),
      file('openspec/changes/add-discount/specs/cart/spec.md', `## ADDED Requirements\n${req('Discount Code')}`),
      file('src/cart.ts', 'export {}'),
    ];
    const e = check(files).errors.join('\n');
    expect(e).toMatch(/Why` is \d+ characters/);
    expect(e).toMatch(/tasks\.md is missing/);
    expect(e).toMatch(/src\/cart\.ts: the proposal may only write/);
  });

  it('requires at least one delta spec', () => {
    expect(check(change('add-discount', '').slice(0, 2)).errors.join('\n')).toMatch(/no delta spec/);
  });
});

describe('OpenSpec flow: spec_check.py, archive mode', () => {
  const id = 'add-discount';
  const archive = `openspec/changes/archive/2026-11-04-${id}`;
  const delta = `## ADDED Requirements\n${req('Discount Code')}\n## MODIFIED Requirements\n${req('Totals', 'adds the discount')}\n## REMOVED Requirements\n### Requirement: Gift Wrap\n**Reason**: retired\n\n## RENAMED Requirements\n- FROM: \`### Requirement: Old Name\`\n- TO: \`### Requirement: New Name\`\n`;
  const source = [...change(id, delta), file('src/cart.ts', 'export const a = 1;\n')];
  // What the archive agent should leave: the merged spec, the folder moved, the code untouched.
  const merged = `# Cart Specification\n\n## Purpose\nCart behaviour for shoppers at checkout.\n\n## Requirements\n${req('Totals', 'adds the discount')}\n${req('New Name')}\n${req('Discount Code')}`;
  const goodAfter = () => [
    file('openspec/specs/cart/spec.md', merged, 'modified'),
    file(`${archive}/proposal.md`, WHY),
    file(`${archive}/tasks.md`, TASKS),
    file(`${archive}/specs/cart/spec.md`, delta),
    file('src/cart.ts', 'export const a = 1;\n'),
  ];
  const archiveCheck = (files: unknown[]) => run('spec_check.py', { mode: 'archive', change_id: id, archive_dir: archive, files, source_files: source });

  it('accepts a faithful merge and move', () => {
    const r = archiveCheck(goodAfter());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.capabilities).toEqual(['cart']);
  });

  it('rejects a folder left behind, a changed archive copy and an unmoved file', () => {
    const files = goodAfter().filter((f) => !f.path.endsWith('tasks.md'));
    files.push(file(`openspec/changes/${id}/proposal.md`, WHY));
    files[2] = file(`${archive}/specs/cart/spec.md`, delta + 'tampered\n');
    const e = archiveCheck(files).errors.join('\n');
    expect(e).toMatch(/still in the change folder/);
    expect(e).toMatch(/differs from/);
    expect(e).toMatch(/tasks\.md was not moved/);
  });

  it('rejects a MODIFIED requirement that was not replaced, a REMOVED one still present, and a missing rename', () => {
    const stale = merged.replace(req('Totals', 'adds the discount'), req('Totals', 'is unchanged')) + req('Gift Wrap') + req('Old Name');
    const files = goodAfter();
    files[0] = file('openspec/specs/cart/spec.md', stale.replace(req('New Name'), ''), 'modified');
    const e = archiveCheck(files).errors.join('\n');
    expect(e).toMatch(/MODIFIED requirement 'Totals' differs from the delta/);
    expect(e).toMatch(/removed requirement 'Gift Wrap' is still present/);
    expect(e).toMatch(/renamed requirement 'Old Name' is still present/);
    expect(e).toMatch(/renamed requirement 'New Name' is missing/);
  });

  it('rejects an ADDED requirement missing from the merged spec', () => {
    const files = goodAfter();
    files[0] = file('openspec/specs/cart/spec.md', merged.replace(req('Discount Code'), ''), 'modified');
    expect(archiveCheck(files).errors.join('\n')).toMatch(/ADDED requirement 'Discount Code' is missing/);
  });

  it('rejects any change to code or to a spec the change has no delta for', () => {
    const files = goodAfter();
    files[4] = file('src/cart.ts', 'export const a = 2;\n');
    files.push(file('openspec/specs/other/spec.md', `# Other\n\n## Purpose\nSomething unrelated to this change at all.\n\n## Requirements\n${req('Z')}`, 'modified'));
    const e = archiveCheck(files).errors.join('\n');
    expect(e).toMatch(/src\/cart\.ts: the archive step changed a file outside openspec/);
    expect(e).toMatch(/openspec\/specs\/other\/spec\.md: changed, but the change has no delta/);
  });

  it('warns about unticked tasks without failing', () => {
    const unticked = source.map((f) => (f.path.endsWith('tasks.md') ? { ...f, content: '- [ ] 1.1 left\n' } : f));
    const after = goodAfter().map((f) => (f.path.endsWith('tasks.md') ? { ...f, content: '- [ ] 1.1 left\n' } : f));
    const r = run('spec_check.py', { mode: 'archive', change_id: id, archive_dir: archive, files: after, source_files: unticked });
    expect(r.ok).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/unticked/);
  });
});

describe('OpenSpec flow: pick_change.py', () => {
  it('prefers the revised round and fails when none ran', () => {
    expect(run('pick_change.py', { first: { a: 1 }, revised: { a: 2 } })).toEqual({ a: 2 });
    expect(run('pick_change.py', { first: { a: 1 }, revised: null })).toEqual({ a: 1 });
    expect(() => run('pick_change.py', { first: null, revised: null })).toThrow();
  });
});
