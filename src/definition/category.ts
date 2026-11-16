/**
 * Workflow categories. A workflow carries `tags` in its definition; its category is read from
 * them, never stored, so a new version with new tags moves the workflow without a migration.
 * The first tag that belongs to a category decides, so authors put the most telling tag first.
 */
export const WORKFLOW_CATEGORIES: ReadonlyArray<{ name: string; tags: readonly string[] }> = [
  { name: 'Delivery', tags: ['delivery', 'sdlc', 'implementation', 'feature', 'release', 'factory'] },
  { name: 'Planning', tags: ['planning', 'breakdown', 'spec', 'sizing', 'readiness'] },
  { name: 'Code review', tags: ['code-review', 'review', 'pull-request', 'merge-conflict'] },
  { name: 'Investigation', tags: ['investigation', 'rca', 'debugging', 'incident', 'triage'] },
  { name: 'Testing', tags: ['testing', 'qa', 'verification'] },
  { name: 'Reports', tags: ['report', 'digest', 'metrics', 'summary'] },
  { name: 'Operations', tags: ['operations', 'ci', 'deploy', 'monitoring', 'maintenance'] },
  { name: 'Security', tags: ['security', 'compliance', 'audit', 'vulnerability'] },
  { name: 'Documentation', tags: ['documentation', 'docs', 'knowledge'] },
  { name: 'Support', tags: ['support', 'customer', 'helpdesk'] },
  { name: 'Data', tags: ['data', 'etl', 'analytics'] },
  { name: 'Learn Azhi', tags: ['learn', 'demo', 'tutorial'] },
];

const BY_TAG = new Map(WORKFLOW_CATEGORIES.flatMap((c) => c.tags.map((t) => [t, c.name] as const)));

/** The tags of a stored definition; anything that is not a list of strings reads as no tags. */
export function tagsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : [];
}

/** The category the tags put a workflow in, or null when no tag names one (the caller shows "Other"). */
export function categoryOf(tags: readonly string[]): string | null {
  for (const t of tags) {
    const c = BY_TAG.get(t.toLowerCase());
    if (c) return c;
  }
  return null;
}
