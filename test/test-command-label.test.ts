import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { describeTestCommand } from '../src/worker/workspace.js';

describe('describeTestCommand', () => {
  const gate = JSON.parse(execFileSync('node', ['examples/sdlc-universal/scripts/build_gate_commands.mjs'], { encoding: 'utf8' })) as Record<'full' | 'static', string>;

  it('names the compressed sdlc-universal gate by its mode instead of printing it', () => {
    expect(describeTestCommand(gate.full)).toContain('full (install, typecheck, test)');
    expect(describeTestCommand(gate.static)).toContain('static (install, typecheck, build)');
    expect(describeTestCommand(gate.static)).not.toContain('base64');
  });

  it('leaves a short command alone and cuts a long one', () => {
    expect(describeTestCommand('npm test')).toBe('npm test');
    const long = describeTestCommand(`node ${'x'.repeat(500)}`);
    expect(long.length).toBeLessThan(400);
    expect(long).toContain('(505 characters)');
  });
});
