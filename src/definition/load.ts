import { Ajv2020 } from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { workflowSchema } from './schema.js';
import type { WorkflowDefinition } from './types.js';

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  node?: string;
  path?: string;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSchema = ajv.compile(workflowSchema as object);

export function parseYaml(text: string): { value?: unknown; diagnostics: Diagnostic[] } {
  const doc = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
  const diagnostics: Diagnostic[] = doc.errors.map((e) => ({ severity: 'error', code: 'yaml_syntax', message: e.message.split('\n')[0]! }));
  if (diagnostics.length) return { diagnostics };
  return { value: doc.toJS(), diagnostics };
}

/** Validates a parsed document against the canonical JSON Schema. */
export function validateDefinition(value: unknown): { definition?: WorkflowDefinition; diagnostics: Diagnostic[] } {
  if (!validateSchema(value)) {
    const diagnostics: Diagnostic[] = [];
    const seen = new Set<string>();
    for (const e of validateSchema.errors ?? []) {
      // `if/then` and `oneOf` produce noisy wrapper errors; keep the specific ones.
      if (e.keyword === 'if' || e.keyword === 'oneOf' || e.keyword === 'not' || e.keyword === 'anyOf') continue;
      const nodeIndex = /^\/nodes\/(\d+)/.exec(e.instancePath)?.[1];
      const nodeId = nodeIndex !== undefined ? (value as any)?.nodes?.[Number(nodeIndex)]?.id : undefined;
      const extra = e.keyword === 'additionalProperties' ? `: ${(e.params as any).additionalProperty}` : e.keyword === 'enum' ? `: ${(e.params as any).allowedValues?.join(', ')}` : '';
      const message = `${e.instancePath || '/'} ${e.message}${extra}`;
      if (seen.has(message)) continue;
      seen.add(message);
      diagnostics.push({ severity: 'error', code: 'schema', message, node: nodeId, path: e.instancePath });
    }
    if (!diagnostics.length) diagnostics.push({ severity: 'error', code: 'schema', message: 'document does not match the workflow schema' });
    return { diagnostics };
  }
  return { definition: value as WorkflowDefinition, diagnostics: [] };
}

export function loadDefinitionText(text: string) {
  const parsed = parseYaml(text);
  if (parsed.diagnostics.length) return { diagnostics: parsed.diagnostics };
  return validateDefinition(parsed.value);
}

export function loadDefinitionFile(path: string) {
  return loadDefinitionText(readFileSync(path, 'utf8'));
}
