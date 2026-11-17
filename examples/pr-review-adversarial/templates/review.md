## {{view.icon}} Azhi adversarial review: {{view.headline}}

{{review.summary}}

**Reviewed:** `{{pr.head_sha}}` against `{{pr.base_ref}}` · **Requirement:** {{view.origin_label}}{{#ticket.title}} - {{ticket.title}}{{/ticket.title}}{{#ticket.url}} ({{ticket.url}}){{/ticket.url}}
**Adversarial verdict:** {{view.verdict_word}} - {{t.verdict_note}}
**Evidence:** {{t.stats.probes_run}} of {{t.stats.probes_selected}} probes executed · {{t.reproduced.length}} reproduced · {{t.ruled_out.length}} ruled out · {{t.unproven.length}} unproven
**Requirements:** {{t.coverage.met}} of {{t.coverage.total}} met{{#t.coverage.partial}}, {{t.coverage.partial}} partial{{/t.coverage.partial}}{{#t.coverage.missing}}, {{t.coverage.missing}} missing{{/t.coverage.missing}}{{#t.coverage.unverifiable}}, {{t.coverage.unverifiable}} not verifiable from the code{{/t.coverage.unverifiable}}{{#t.coverage.inferred}} (inferred from the PR description, so gaps are advisory){{/t.coverage.inferred}}
{{#view.dirty}}

:warning: A probe changed files outside its scratch folder, so every executed probe was discarded as invalid ({{view.dirty_count}} file(s)).
{{/view.dirty}}
{{#t.reproduced.length}}

### Reproduced failures
{{/t.reproduced.length}}
{{#t.reproduced}}

#### {{id}} - {{severity}} - {{level}}: {{title}}
- **Where:** {{mechanism}}
- **Probe:** `{{command}}`
- **Observed:** {{observed}}
- **Confirmed:** confidence {{confidence}} - {{verification}}
{{/t.reproduced}}
{{#t.criteria.length}}

### Requirements
| | Criterion | Status | Evidence |
|---|---|---|---|
{{/t.criteria.length}}
{{#t.criteria}}
| {{id}} | {{text}} | {{status}} | {{evidence}}{{#path}} (`{{path}}{{#line}}:{{line}}{{/line}}`){{/path}} |
{{/t.criteria}}
{{#t.findings.length}}

### Review findings
| Severity | Where | Finding |
|---|---|---|
{{/t.findings.length}}
{{#t.findings}}
| {{severity}} | `{{path}}{{#line}}:{{line}}{{/line}}` | **{{id}}** {{title}}. {{detail}} |
{{/t.findings}}
{{#t.unproven.length}}

### Unproven
| ID | Scenario | Why it is not proven |
|---|---|---|
{{/t.unproven.length}}
{{#t.unproven}}
| {{id}} | {{title}}{{#decisive}} (decisive){{/decisive}} | {{reason}} |
{{/t.unproven}}
{{#t.check_by_hand.length}}

### Check by hand
| Severity | Where | What to check |
|---|---|---|
{{/t.check_by_hand.length}}
{{#t.check_by_hand}}
| {{severity}} | `{{path}}{{#line}}:{{line}}{{/line}}` | **{{id}}** {{title}}. {{detail}} |
{{/t.check_by_hand}}
{{#review.next_steps.length}}

### Next steps
{{/review.next_steps.length}}
{{#review.next_steps}}
- {{.}}
{{/review.next_steps}}
{{#t.ruled_out.length}}

<details><summary>Ruled out ({{t.ruled_out.length}})</summary>

| ID | Scenario | Evidence level | Result |
|---|---|---|---|
{{#t.ruled_out}}
| {{id}} | {{title}} | {{level}} | {{observed}}{{reason}} |
{{/t.ruled_out}}

</details>
{{/t.ruled_out.length}}
{{#t.attack_surface.length}}

<details><summary>Attack surface</summary>

| Element | What the change adds or assumes | Where |
|---|---|---|
{{#t.attack_surface}}
| {{element}} | {{what}} | {{where}} |
{{/t.attack_surface}}

</details>
{{/t.attack_surface.length}}
{{#t.deferred.length}}

<details><summary>Deferred candidates ({{t.deferred.length}})</summary>

{{#t.deferred}}
- {{title}} - {{why}}
{{/t.deferred}}

</details>
{{/t.deferred.length}}
{{#ambiguous.length}}

<details><summary>Open questions in the requirement</summary>

{{#ambiguous}}
- {{.}}
{{/ambiguous}}

</details>
{{/ambiguous.length}}

---
*{{view.verdict_word}} is the verdict of the attacks that were tried; "Holds" is not proof of correctness. Findings were checked by an independent verifier (confidence {{t.stats.min_confidence}} or more). Probes ran on a worker in a throwaway checkout; nothing in the repository was changed.*
