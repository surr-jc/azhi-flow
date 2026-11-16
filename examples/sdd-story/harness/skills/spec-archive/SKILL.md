---
name: spec-archive
description: The mechanical archive step - merge a change's delta specs into openspec/specs and move the change folder to the dated archive folder, exactly and without rewriting
---
# Archive a change

You are given the change folder (`openspec/changes/<id>/`), the archive folder
(`openspec/changes/archive/<date>-<id>/`) and the delta list. Do exactly this, nothing more:

1. **For each delta file** `openspec/changes/<id>/specs/<capability>/spec.md`, open
   `openspec/specs/<capability>/spec.md` (create it if the capability is new, starting with
   `# <capability> Specification`, then `## Purpose` from the delta's purpose, then `## Requirements`).
2. **Apply in this order**, matching requirement headers exactly:
   1. RENAMED: change the header from the FROM name to the TO name.
   2. REMOVED: delete the whole requirement block (header through its last scenario).
   3. MODIFIED: replace the whole existing block with the delta's block, byte for byte.
   4. ADDED: append the delta's block at the end of `## Requirements`.
3. **Copy blocks verbatim.** Do not fix wording, reorder scenarios, or normalise anything. A merged
   requirement must be identical to the block in the delta; the check compares them.
4. **Move the change folder** to the archive folder: every file in it (`proposal.md`, `design.md`,
   `tasks.md`, `specs/...`) is written at the same relative path under the archive folder with identical
   content, and the originals are deleted so nothing remains under `openspec/changes/<id>/`.
5. **Touch nothing else.** No code, no other capability, no other change, no other archive folder.

If a MODIFIED, REMOVED or RENAMED target is missing, or an ADDED name already exists, stop without
merging that capability and say which in `summary`; do not improvise. Report one `merged` entry per
capability with the number of requirements applied per operation.
