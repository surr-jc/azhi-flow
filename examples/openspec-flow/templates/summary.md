*Delivered {{ticket.key}}: {{ticket.title}}*

Pull request: {{pr.url}} ({{branch.branch}}, commit {{branch.commit_sha}})

OpenSpec change `{{change.id}}`, archived at `{{change.archive_dir}}`
Proposal approved by {{proposal_by}}; released by {{release_by}}
{{#deltas}}
• {{op}} {{capability}}: {{requirement}}
{{/deltas}}

Spec review: {{review.summary}}
{{#review.findings}}
– {{severity}} ({{where}}): {{finding}}
{{/review.findings}}

Change: {{apply.summary}} — {{apply.workspace.stats.files}} file(s), +{{apply.workspace.stats.additions}} -{{apply.workspace.stats.deletions}}
Tests: {{apply.workspace.tests.status}} on attempt {{apply.workspace.tests.attempts}}

Verification: {{verify.summary}}
{{#verify.issues}}
– {{level}} {{dimension}}: {{issue}}
{{/verify.issues}}
{{#apply.deviations}}
– Deviation: {{.}}
{{/apply.deviations}}
