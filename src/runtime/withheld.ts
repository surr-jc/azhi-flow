/**
 * Which withheld input fields an approval should tell its approver about: the `step.field` entries of the run's
 * `context_withheld` flag whose step is upstream of the approval (anything it waits on, directly or through other
 * steps). A field withheld from a step on another branch, or after the approval, did not shape what is being decided.
 * Runs inside the Temporal workflow sandbox: pure, no Node-only imports.
 */
export function withheldBefore(nodes: Array<{ id: string; deps: string[] }>, withheld: string[] | undefined, approvalId: string): string[] {
  if (!withheld?.length) return [];
  const byId = new Map(nodes.map((n) => [n.id, n.deps]));
  const upstream = new Set<string>();
  const stack = [...(byId.get(approvalId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (upstream.has(id)) continue;
    upstream.add(id);
    stack.push(...(byId.get(id) ?? []));
  }
  // Step ids are identifiers, so the first dot separates the step from the field.
  return withheld.filter((entry) => upstream.has(entry.slice(0, entry.indexOf('.'))));
}
