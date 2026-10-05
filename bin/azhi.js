#!/usr/bin/env node
// Runs the TypeScript CLI directly through tsx; there is no separate build step in the alpha.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { register } from 'tsx/esm/api';

// On Windows, SWC (which Temporal uses to bundle workflows) refuses to cache its native addon
// under %LOCALAPPDATA% when that folder grants rights to an app container; use ~/.azhi instead.
if (process.platform === 'win32' && !process.env.SWC_NATIVE_BINDING_CACHE) {
  process.env.SWC_NATIVE_BINDING_CACHE = join(process.env.AZHI_HOME ?? join(homedir(), '.azhi'), 'swc-cache');
}

register();
await import('../src/cli/main.ts');
