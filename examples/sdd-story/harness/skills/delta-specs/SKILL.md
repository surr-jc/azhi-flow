---
description: Write delta specs - ADDED, MODIFIED, REMOVED and RENAMED requirements - so archiving can merge them mechanically
name: delta-specs
---
# Delta specs

A delta file lives at `openspec/changes/<id>/specs/<capability>/spec.md` and describes only the change.
Group requirements under these sections (each optional, at least one present):

| Section | Content | Merge effect |
|---|---|---|
| `## ADDED Requirements` | complete new requirements with scenarios | appended; the name must not exist yet |
| `## MODIFIED Requirements` | the **whole** new requirement (header, text, every scenario) | replaces the existing one with the same name |
| `## REMOVED Requirements` | the header, then `**Reason**:` and `**Migration**:` lines | deleted |
| `## RENAMED Requirements` | `- FROM: `### Requirement: Old`` then `- TO: `### Requirement: New`` | renamed |

Applied in this order: rename, remove, modify, add.

## Choosing the section

- A name in the scan's list for that capability is existing: change it with MODIFIED, drop it with REMOVED.
  The header must match exactly. Copy the current requirement first, then edit it, so no scenario is lost.
- A new concern is ADDED, even when it sits next to an old one. Never use ADDED for a name that exists
  (two competing requirements) or MODIFIED for one that does not (nothing to replace).
- A name-only change is RENAMED; a name and behaviour change is RENAMED to the new name plus MODIFIED under the new name.
- A capability with no current spec starts the delta with `## Purpose` (at least 50 characters) and only ADDED.

## Checks the workflow runs on your files

Every ADDED or MODIFIED requirement has SHALL or MUST and a scenario with WHEN and THEN; names are
unique in a delta; MODIFIED, REMOVED and RENAMED targets exist; ADDED and RENAMED-to names do not; the
proposal has Why and What Changes; tasks.md has checklist items; nothing outside the change folder is written.
