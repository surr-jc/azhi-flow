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
  /**
   * Values the example install asks for (`azhi example install --set name=value`, or the Examples
   * page), filled into the tools wherever `{{name}}` appears, for example a Jira site address.
   */
  settings?: Array<{
    name: string;
    title?: string;
    description?: string;
    placeholder?: string;
    /** Used when neither this install nor an earlier one gives a value. */
    default?: string;
    /** The install is refused until this has a value (given, filled in earlier, or its default). Shown to the person before they start. */
    required?: boolean;
    /** When an optional setting matters, for example "Jira tickets". */
    needed_for?: string;
  }>;
}

export function loadAdminConfig(path: string): AdminConfig {
  return (parse(readFileSync(path, 'utf8')) ?? {}) as AdminConfig;
}
