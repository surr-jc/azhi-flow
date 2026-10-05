*Delivered {{ticket.key}}: {{ticket.title}}*

Requirements: {{requirements.summary}}
{{#requirements.acceptance_criteria}}
• {{.}}
{{/requirements.acceptance_criteria}}

Design: {{design.summary}}
Change: {{change.summary}}
Review: {{review.summary}}
Tests: {{tests.status}}, {{tests.passed}} passed, {{tests.failed}} failed, coverage {{tests.coverage_pct}}%

Retro notes
{{#design.risks}}
– Risk: {{risk}} (mitigation: {{mitigation}})
{{/design.risks}}
{{#review.findings}}
– Review {{severity}}: {{text}}
{{/review.findings}}
