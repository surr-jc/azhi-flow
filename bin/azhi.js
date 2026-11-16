#!/usr/bin/env node
// A source checkout runs the TypeScript CLI directly through tsx. The packaged app (npm run build:app)
// has compiled JavaScript next to this file and needs neither tsx nor a bundling step.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const compiled = fileURLToPath(new URL('../src/cli/main.js', import.meta.url));
if (existsSync(compiled)) {
  await import('../src/cli/main.js');
} else {
  // On Windows, SWC (which Temporal uses to bundle workflows) refuses to cache its native addon
  // under %LOCALAPPDATA% when that folder grants rights to an app container; use ~/.azhi instead.
  if (process.platform === 'win32' && !process.env.SWC_NATIVE_BINDING_CACHE) {
    process.env.SWC_NATIVE_BINDING_CACHE = join(process.env.AZHI_HOME ?? join(homedir(), '.azhi'), 'swc-cache');
  }
  const { register } = await import('tsx/esm/api');
  register();
  await import('../src/cli/main.ts');
}
