import { describe, expect, it } from 'vitest';
import { memoryRequirement } from '../src/plan/run-plan.js';

/**
 * A script step's memory limit is enforced only by a Linux worker with prlimit. Elsewhere the plan warns and the step
 * runs with its time limit, so a workflow written on one platform installs on another; a server that must always
 * have the limit can make it a blocker again.
 */
describe('memory limit in the run plan', () => {
  it('is native where a worker can enforce it', () => {
    expect(memoryRequirement(256, true, true, false)).toEqual({ name: 'memory limit 256 MB', mark: 'native', detail: 'prlimit' });
    expect(memoryRequirement(256, true, true, true).mark).toBe('native');
  });

  it('is a warning, not a blocker, where no worker can enforce it (Windows, macOS)', () => {
    const r = memoryRequirement(256, false, true, false);
    expect(r.mark).toBe('unverified');
    expect(r.detail).toContain('not enforced');
    expect(r.detail).toContain('time limit');
  });

  it('is a blocker when the server requires memory limits', () => {
    const r = memoryRequirement(256, false, true, true);
    expect(r.mark).toBe('unsupported');
    expect(r.detail).toContain('AZHI_REQUIRE_MEMORY_LIMITS=1');
  });

  it('is unverified when no capable worker is online, whatever the policy', () => {
    expect(memoryRequirement(256, false, false, false).mark).toBe('unverified');
    expect(memoryRequirement(256, false, false, true).mark).toBe('unverified');
  });

  it('reads the policy from AZHI_REQUIRE_MEMORY_LIMITS by default', () => {
    const before = process.env.AZHI_REQUIRE_MEMORY_LIMITS;
    try {
      delete process.env.AZHI_REQUIRE_MEMORY_LIMITS;
      expect(memoryRequirement(64, false, true).mark).toBe('unverified');
      process.env.AZHI_REQUIRE_MEMORY_LIMITS = '1';
      expect(memoryRequirement(64, false, true).mark).toBe('unsupported');
    } finally {
      if (before === undefined) delete process.env.AZHI_REQUIRE_MEMORY_LIMITS;
      else process.env.AZHI_REQUIRE_MEMORY_LIMITS = before;
    }
  });
});
