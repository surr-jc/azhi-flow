import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyModelDefaults, modelDefaultsProblems, parseProfile, usesDefaultModel } from '../src/agents/profile.js';
import { compile } from '../src/compiler/compile.js';
import { loadDefinitionText } from '../src/definition/load.js';
import { packageFromDirectory } from '../src/definition/package.js';
import { startHarness, uploadDir, type Harness } from './helpers/harness.js';

/**
 * The provider and model a person chooses for a workflow or a run apply only to steps whose profile says
 * `name: default`; a step that names its own model keeps its provider and model.
 */
const profile = (model: string) => parseProfile(`model: ${model}\ninstructions: x\n`, 'p.yaml');

describe('model defaults: the rule', () => {
  it('replaces the provider, credential and model of a default-model profile only', () => {
    const def = profile('{provider: github-copilot, name: default, credential: my-copilot}');
    expect(usesDefaultModel(def)).toBe(true);
    expect(applyModelDefaults(def, { provider: 'anthropic', name: 'claude-opus-5-5' }).model).toEqual({ provider: 'anthropic', name: 'claude-opus-5-5' });
    // A provider alone takes that provider's server default model.
    expect(applyModelDefaults(def, { provider: 'openai-chatgpt' }).model).toEqual({ provider: 'openai-chatgpt', name: 'default' });
    // Same provider: the profile's own credential is kept.
    expect(applyModelDefaults(def, { provider: 'github-copilot', name: 'gpt-5.4' }).model).toEqual({ provider: 'github-copilot', name: 'gpt-5.4', credential: 'my-copilot' });
    // A profile with no name counts as default.
    expect(applyModelDefaults(profile('{provider: anthropic}'), { provider: 'openai' }).model.provider).toBe('openai');
  });

  it('leaves a profile that names a model, a scripted profile and an empty choice alone', () => {
    const pinned = profile('{provider: github-copilot, name: gpt-5.4}');
    expect(usesDefaultModel(pinned)).toBe(false);
    expect(applyModelDefaults(pinned, { provider: 'anthropic', name: 'x' })).toBe(pinned);
    const scripted = parseProfile('model: {provider: scripted}\ninstructions: x\nscript: []\n', 'p.yaml');
    expect(applyModelDefaults(scripted, { provider: 'anthropic' })).toBe(scripted);
    const def = profile('{provider: anthropic, name: default}');
    expect(applyModelDefaults(def, undefined)).toBe(def);
    expect(applyModelDefaults(def, {})).toBe(def);
  });

  it('checks a choice: known provider, valid model id, and a model needs its provider', () => {
    expect(modelDefaultsProblems(undefined)).toEqual([]);
    expect(modelDefaultsProblems({ provider: 'anthropic', name: 'claude-sonnet-5' })).toEqual([]);
    expect(modelDefaultsProblems({ provider: 'nope' })[0]).toContain('provider must be one of');
    expect(modelDefaultsProblems({ name: 'gpt-5.4' })[0]).toContain('needs model_defaults.provider');
    expect(modelDefaultsProblems({ provider: 'openai', name: 'bad id!' })[0]).toContain('model id');
    expect(modelDefaultsProblems({ provider: 'openai', extra: 1 })[0]).toContain('not a known field');
  });

  it('is part of the workflow definition and checked when it compiles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'azhi-md-'));
    cpSync('examples/pr-review', dir, { recursive: true });
    const wf = join(dir, 'workflow.yaml');
    const doc = parse(readFileSync(wf, 'utf8'));
    doc.model_defaults = { provider: 'anthropic', name: 'claude-sonnet-5' };
    writeFileSync(wf, stringify(doc, { lineWidth: 0 }));
    const pkg = packageFromDirectory(dir);
    const ok = compile(loadDefinitionText(pkg.readText(pkg.manifest.workflow)!).definition!, { pkg });
    expect(ok.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    doc.model_defaults = { name: 'claude-sonnet-5' };
    writeFileSync(wf, stringify(doc, { lineWidth: 0 }));
    const bad = compile(loadDefinitionText(packageFromDirectory(dir).readText('workflow.yaml')!).definition!, { pkg: packageFromDirectory(dir) });
    expect(bad.diagnostics.some((d) => d.code === 'invalid_model_defaults' || /model_defaults/.test(d.message))).toBe(true);
  });
});

describe('model defaults: the run plan and the options', () => {
  let h: Harness;
  let version: string;

  beforeAll(async () => {
    h = await startHarness({ settings: { copilotModel: 'claude-sonnet-5', anthropicModel: 'claude-sonnet-5-5' } });
    const dir = mkdtempSync(join(tmpdir(), 'azhi-md-pr-'));
    cpSync('examples/pr-review', dir, { recursive: true });
    const wf = join(dir, 'workflow.yaml');
    writeFileSync(wf, readFileSync(wf, 'utf8').replace('{{slack_channel}}', 'C-TEST'));
    for (const t of parse(readFileSync('examples/pr-review/azhi.config.yaml', 'utf8')).tools) {
      t.transport.config = { repos: ['acme/payments'] };
      await h.api.post('/v1/tools', t);
    }
    const res = await uploadDir(h.api, dir);
    expect(res.diagnostics.filter((d: any) => d.severity === 'error')).toEqual([]);
    version = res.version.id;
  });
  afterAll(async () => {
    await h?.stop();
  });

  const modelOf = (plan: any, id: string) => plan.nodes.find((n: any) => n.id === id).model;

  it('shows each step\'s provider and model, and where it came from', async () => {
    const plan = await h.api.get<any>(`/v1/versions/${version}/plan`);
    expect(modelOf(plan, 'correctness')).toEqual({ provider: 'github-copilot', name: 'claude-sonnet-5', source: 'server_default' });
    expect(modelOf(plan, 'security')).toEqual({ provider: 'github-copilot', name: 'claude-opus-5.5', source: 'profile' });
    expect(modelOf(plan, 'verify')).toEqual({ provider: 'github-copilot', name: 'gpt-5.4', source: 'profile' });
  });

  it('applies a chosen provider and model to default-model steps only', async () => {
    const plan = await h.api.get<any>(`/v1/versions/${version}/plan?provider=anthropic&model=claude-opus-5-5`);
    expect(modelOf(plan, 'correctness')).toEqual({ provider: 'anthropic', name: 'claude-opus-5-5', source: 'run_choice' });
    expect(modelOf(plan, 'quality')).toEqual({ provider: 'anthropic', name: 'claude-opus-5-5', source: 'run_choice' });
    // Steps that name their own model keep it.
    expect(modelOf(plan, 'security')).toEqual({ provider: 'github-copilot', name: 'claude-opus-5.5', source: 'profile' });
    const req = plan.nodes.find((n: any) => n.id === 'correctness').requirements;
    expect(req).toContainEqual(expect.objectContaining({ name: 'model binding', detail: 'anthropic claude-opus-5-5 (chosen for this run)' }));
    // The chosen provider's own credential is now the one the step needs.
    expect(req).toContainEqual(expect.objectContaining({ name: 'credential anthropic-api-key' }));
    // A provider alone: that provider's server default model.
    const only = await h.api.get<any>(`/v1/versions/${version}/plan?provider=anthropic`);
    expect(modelOf(only, 'correctness')).toMatchObject({ provider: 'anthropic', name: 'claude-sonnet-5-5', source: 'run_choice' });
  });

  it('marks a provider the step\'s executor cannot drive, and refuses a model without a provider', async () => {
    const plan = await h.api.get<any>(`/v1/versions/${version}/plan?provider=openai`);
    const req = plan.nodes.find((n: any) => n.id === 'correctness').requirements.find((r: any) => r.name === 'model binding');
    expect(req).toMatchObject({ mark: 'unsupported' });
    expect(req.detail).toContain('supports');
    await expect(h.api.get(`/v1/versions/${version}/plan?model=gpt-5.4`)).rejects.toThrow();
  });

  it('refuses a run that names a model without a provider, and lists providers with whether each is ready', async () => {
    await expect(h.api.post('/v1/runs', { version, inputs: { repo: 'a/b', pr: 1 }, model_defaults: { name: 'x' } })).rejects.toThrow();
    const opts = await h.api.get<any>('/v1/model-options');
    expect(opts.providers.map((p: any) => p.id)).toEqual(['anthropic', 'openai', 'github-copilot', 'openai-chatgpt']);
    const copilot = opts.providers.find((p: any) => p.id === 'github-copilot');
    expect(copilot).toMatchObject({ ready: false, server_default_model: 'claude-sonnet-5', executors: ['opencode'] });
    expect(opts.providers.find((p: any) => p.id === 'anthropic')).toMatchObject({ executors: ['model-agent', 'opencode', 'claude-agent-sdk'].filter((e) => e !== 'x'), server_default_model: 'claude-sonnet-5-5' });
    await h.api.put('/v1/secrets/github-copilot-token', { value: 'gho_x' });
    expect((await h.api.get<any>('/v1/model-options')).providers.find((p: any) => p.id === 'github-copilot').ready).toBe(true);
    const models = await h.api.get<any>('/v1/model-options/models?provider=anthropic');
    expect(models.models.length).toBeGreaterThan(0);
  });
});
