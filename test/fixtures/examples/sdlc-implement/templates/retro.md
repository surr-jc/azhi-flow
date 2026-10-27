*Delivered {{ticket.key}}: {{ticket.title}}*

Pull request: {{pr.url}} ({{branch.branch}}, commit {{branch.commit_sha}})

Requirements: {{requirements.summary}}
{{#requirements.acceptance_criteria}}
• {{.}}
{{/requirements.acceptance_criteria}}

Design: {{design.summary}} (confidence {{design.confidence}}/10)
Change: {{change.summary}} — {{change.stats.files}} file(s), +{{change.stats.additions}} -{{change.stats.deletions}}
Tests: {{change.tests.status}} on attempt {{change.tests.attempts}} ({{change.tests.command}})
Review: {{review.summary}}

Planned vs actual
{{#change.deviations}}
– Deviation: {{.}}
{{/change.deviations}}
{{#design.risks}}
– Risk: {{risk}} (mitigation: {{mitigation}})
{{/design.risks}}
{{#review.findings}}
– Review {{severity}}: {{text}}
{{/review.findings}}
