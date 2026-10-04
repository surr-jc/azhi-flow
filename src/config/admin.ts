import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { ToolSpec } from '../gateway/types.js';

/**
 * Declarative admin configuration (`azhi.config.yaml`), applied with `azhi apply`.
 * This is the alpha's admin surface for tools, schedules and workers; secrets are referenced
 * by name only and set separately with `azhi secret set`.
 */
export interface AdminConfig {
  tools?: ToolSpec[];
  schedules?: Array<{ id: string; workflow: string; cron?: string; timezone?: string; inputs?: Record<string, unknown>; enabled?: boolean }>;
  secrets?: string[];
}

export function loadAdminConfig(path: string): AdminConfig {
  return (parse(readFileSync(path, 'utf8')) ?? {}) as AdminConfig;
}
