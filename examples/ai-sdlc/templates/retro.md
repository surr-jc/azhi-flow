*Delivered {{ticket.key}}: {{ticket.title}}*

Pull request: {{pr.url}} ({{branch.branch}}, commit {{branch.commit_sha}})

Review path: {{weight}}; fix rounds used: {{final.round}}{{#final.needs_human_attention}}; flagged for human attention{{/final.needs_human_attention}}
Definition of ready: {{dor.summary}}

Requirements: {{requirements.summary}}
{{#requirements.acceptance_criteria}}
• {{.}}
{{/requirements.acceptance_criteria}}

Design: {{design.summary}} (confidence {{design.confidence}}/10, risk {{design.risk}})
Change: {{final.change.summary}} — {{final.change.stats.files}} file(s), +{{final.change.stats.additions}} -{{final.change.stats.deletions}}
Tests: {{final.change.tests.status}} on attempt {{final.change.tests.attempts}} ({{final.change.tests.command}})
{{#final.verdict.reviewers}}
Review ({{reviewer}}): {{#approved}}approved{{/approved}}{{^approved}}changes requested{{/approved}} — {{summary}}
{{/final.verdict.reviewers}}

Planned vs actual
{{#final.change.deviations}}
– Deviation: {{.}}
{{/final.change.deviations}}
{{#design.risks}}
– Risk: {{risk}} (mitigation: {{mitigation}})
{{/design.risks}}
{{#final.verdict.findings}}
– {{reviewer}} {{severity}}: {{message}}
{{/final.verdict.findings}}

Evidence record sha256: {{final.evidence.record_sha256}}
