*Delivered {{ticket.key}}: {{ticket.title}}*

Pull request: {{pr.url}} ({{branch.branch}}, commit {{branch.commit_sha}}). Signed off by {{signoff_by}}.

OpenSpec change `{{change.id}}`, archived at `{{change.archive_dir}}`
Proposal approved by {{proposal_by}}
{{#deltas}}
• {{op}} {{capability}}: {{requirement}}
{{/deltas}}

Spec review: {{spec_review.summary}}
{{#spec_review.findings}}
– {{severity}} ({{where}}): {{finding}}
{{/spec_review.findings}}

Change: {{apply.summary}} — {{apply.workspace.stats.files}} file(s), +{{apply.workspace.stats.additions}} -{{apply.workspace.stats.deletions}}
Tests: {{apply.workspace.tests.status}} on attempt {{apply.workspace.tests.attempts}}

Verification: {{verify.summary}}
{{#verify.issues}}
– {{level}} {{dimension}}: {{issue}}
{{/verify.issues}}
{{#apply.deviations}}
– Deviation: {{.}}
{{/apply.deviations}}

Pull request review ({{review.status}}): {{review.summary}}
{{#review.remaining}}
– {{severity}} {{path}}: {{title}}
{{/review.remaining}}
{{#fix}}
Fix round: {{summary}}. Tests {{tests_status}} on attempt {{tests_attempts}}; the fix was not reviewed again.
{{#fixed}}
– Fixed: {{.}}
{{/fixed}}
{{#skipped}}
– Not fixed: {{.}}
{{/skipped}}
{{/fix}}
