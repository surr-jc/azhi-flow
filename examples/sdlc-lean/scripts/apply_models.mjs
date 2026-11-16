// Pins a model per role in profiles/*.yaml, by tier, for one provider.
//   node examples/sdlc-universal/scripts/apply_models.mjs <anthropic|github-copilot|openai-chatgpt>
//   node examples/sdlc-universal/scripts/apply_models.mjs default     (back to "the server or the run chooses")
// Each profile carries a `# tier: strong|balanced|light|alt` comment; this rewrites only its `model:` line.
// With `default`, every profile says `name: default`, so `--provider`/`--model` on `azhi run`, the workflow's
// model_defaults or the server's default decide. Run it before `azhi example install`.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const provider = process.argv[2];
const dir = new URL('../profiles/', import.meta.url);
const models = JSON.parse(readFileSync(new URL('../models.json', import.meta.url), 'utf8'));
const providers = Object.keys(models).filter((k) => !k.startsWith('_'));
if (provider !== 'default' && !providers.includes(provider)) {
  console.error(`usage: apply_models.mjs <${[...providers, 'default'].join('|')}>`);
  process.exit(2);
}
for (const f of readdirSync(dir).filter((x) => x.endsWith('.yaml'))) {
  const text = readFileSync(new URL(f, dir), 'utf8');
  const tier = /^# tier: (strong|balanced|light|alt)\s*$/m.exec(text)?.[1];
  if (!tier) throw new Error(`${f}: no "# tier:" line`);
  if (!/^model: .*$/m.test(text)) throw new Error(`${f}: no model line`);
  const isDefault = provider === 'default';
  const p = isDefault ? models.anthropic : models[provider];
  const name = isDefault ? 'default' : p[tier];
  const line = `model: {provider: ${isDefault ? 'anthropic' : provider}, name: ${name}, credential: ${p.credential}}`;
  writeFileSync(new URL(f, dir), text.replace(/^model: .*$/m, line));
  console.log(`${f.padEnd(26)} ${tier.padEnd(9)} ${name}`);
}
