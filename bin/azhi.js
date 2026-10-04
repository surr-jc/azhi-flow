#!/usr/bin/env node
// Runs the TypeScript CLI directly through tsx; there is no separate build step in the alpha.
import { register } from 'tsx/esm/api';

register();
await import('../src/cli/main.ts');
