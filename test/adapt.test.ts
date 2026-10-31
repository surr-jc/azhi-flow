import { describe, expect, it } from 'vitest';
import { adaptWorkflow } from '../src/plan/adapt.js';

/** Fits a workflow to the sign-ins a workspace has: provider, model and harness for default-model steps. */
const PROFILES: Record<string, string> = {
  'profiles/review@1.yaml': 'model: {provider: anthropic, name: default}\ninstructions: x\n',
  'profiles/pinned@1.yaml': 'model: {provider: anthropic, name: claude-opus-5-5}\ninstructions: x\n',
};

function version(nodes: Array<Record<string, unknown>>, model_defaults?: unknown): any {
  return {
    definition: { id: 'wf', ...(model_defaults ? { model_defaults } : {}), nodes },
    plan: { nodes: nodes.map((def) => ({ id: def.id, type: 'agent', def })) },
  };
}
const read = async (p: string) => {
  if (!(p in PROFILES)) throw new Error(`no ${p}`);
  return PROFILES[p]!;
};
const adapt = (v: any, ready: any[], req = {}) => adaptWorkflow({} as any, 'ws', v, ready, req, read);

describe('adaptWorkflow', () => {
  it('changes nothing when every step already fits a signed-in provider', async () => {
    const r = await adapt(version([{ id: 'a', type: 'agent', profile: 'review@1' }]), ['anthropic']);
    expect(r.unchanged).toBe(true);
    expect(r.definition).toBeUndefined();
    expect(r.steps[0]).toMatchObject({ node: 'a', status: 'ok' });
  });

  it('moves default-model steps to the signed-in provider and gives them the harness that drives it', async () => {
    const v = version([{ id: 'a', type: 'agent', profile: 'review@1' }]);
    const r = await adapt(v, ['github-copilot']);
    expect(r.unchanged).toBe(false);
    expect(r.model_defaults).toEqual({ provider: 'github-copilot' });
    expect(r.steps[0]).toMatchObject({ status: 'changed', to: { executor: 'opencode', provider: 'github-copilot' } });
    expect((r.definition as any).model_defaults).toEqual({ provider: 'github-copilot' });
    expect((r.definition as any).nodes[0].executor).toBe('opencode');
    // The version passed in is not edited.
    expect(v.definition.nodes[0].executor).toBeUndefined();
  });

  it('writes a chosen provider and model, and drops executor when model-agent suffices', async () => {
    const r = await adapt(version([{ id: 'a', type: 'agent', profile: 'review@1', executor: 'opencode' }]), ['anthropic', 'openai'], { provider: 'openai', model: 'gpt-5' });
    expect((r.definition as any).model_defaults).toEqual({ provider: 'openai', name: 'gpt-5' });
    expect((r.definition as any).nodes[0].executor).toBeUndefined();
  });

  it('keeps a step with a checkout on OpenCode, and reports it blocked when OpenCode cannot drive the provider', async () => {
    const node = { id: 'a', type: 'agent', profile: 'review@1', executor: 'opencode', workspace: { repo: 'o/r', ref: 'main' } };
    const ok = await adapt(version([node]), ['anthropic', 'openai'], { provider: 'anthropic' });
    expect(ok.steps[0]!.to.executor).toBe('opencode');
    const blocked = await adapt(version([node]), ['openai'], { provider: 'openai' });
    expect(blocked.steps[0]).toMatchObject({ status: 'blocked' });
    expect(blocked.steps[0]!.reason).toContain('OpenCode only');
  });

  it('leaves a step that names its own model alone and says so when its provider is not signed in', async () => {
    const r = await adapt(version([{ id: 'p', type: 'agent', profile: 'pinned@1' }, { id: 'a', type: 'agent', profile: 'review@1' }]), ['github-copilot']);
    expect(r.steps.find((s) => s.node === 'p')).toMatchObject({ status: 'blocked' });
    expect(r.steps.find((s) => s.node === 'p')!.reason).toContain('change its profile');
    expect((r.definition as any).nodes.find((n: any) => n.id === 'p').executor).toBeUndefined();
  });

  it('prefers a forced harness only where it can drive the provider', async () => {
    const r = await adapt(version([{ id: 'a', type: 'agent', profile: 'review@1' }]), ['anthropic'], { executor: 'claude-agent-sdk' });
    expect((r.definition as any).nodes[0].executor).toBe('claude-agent-sdk');
    const ignored = await adapt(version([{ id: 'a', type: 'agent', profile: 'review@1' }]), ['openai'], { provider: 'openai', executor: 'claude-agent-sdk' });
    expect(ignored.steps[0]!.to.executor).toBe('model-agent');
  });
});
