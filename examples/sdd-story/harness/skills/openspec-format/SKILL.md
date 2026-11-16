---
name: openspec-format
description: The OpenSpec folder layout and file formats - specs, changes, proposal, tasks, design, requirements and scenarios - so every agent reads and writes the same shapes the workflow's checker accepts
---
# OpenSpec format

## Layout

```
openspec/
  config.yaml                      project context for the agents (optional)
  specs/<capability>/spec.md       what the system does today (the source of truth)
  changes/<change-id>/             one proposed change, not yet merged
    proposal.md  design.md  tasks.md
    specs/<capability>/spec.md     DELTA specs: only what this change adds, modifies or removes
  changes/archive/<date>-<id>/     finished changes, kept whole
```

A capability is one purpose, named in kebab-case (`user-auth`). `specs/` changes only when a change is
archived; until then the change folder is the proposal.

## Requirements and scenarios

```markdown
### Requirement: Session Expiration
The system SHALL expire a session after 30 minutes without activity.

#### Scenario: Idle session
- **WHEN** a session has had no activity for 30 minutes
- **THEN** the next request is rejected as unauthenticated
```

- The header is exactly `### Requirement: <name>`; the name is the requirement's identity.
- The text states observable behaviour with SHALL or MUST. SHOULD and MAY are weaker and do not count as the keyword.
- Every requirement has at least one scenario, with exactly four hashes: `#### Scenario: <name>`.
  Three or five hashes, a bullet or bold text is not a scenario.
- A scenario uses `- **WHEN**` and `- **THEN**` lines (optional `GIVEN` and `AND`). Cover the error and
  boundary case, not only the happy path.
- One behaviour per requirement. Libraries, class names and step lists belong in `design.md` or `tasks.md`.

## proposal.md

`## Why` (50 to 1000 characters: the problem), `## What Changes` (bullets; mark breaking changes
`**BREAKING**`), `## Capabilities` (new and modified capability names), `## Impact` (code and systems).
Keep it to a page or two.

## tasks.md

`## 1. Group` headings with `- [ ] 1.1 task` items, in the order they are done. Say how each is verified.
Tests and docs go in the group that produces the work.

## design.md (only when there is a real trade-off)

`## Context`, `## Goals / Non-Goals`, `## Decisions` (what and why, with the alternatives), `## Risks / Trade-offs`.

## Reading a repository

The names in the existing specs are data. Copy them exactly; never "fix" a name.
