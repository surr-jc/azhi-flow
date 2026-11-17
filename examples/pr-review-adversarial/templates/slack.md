*Adversarial PR review: {{pr.repo}}#{{pr.number}} {{pr.title}}* - {{view.icon}} {{view.headline}} (adversarial verdict: {{view.verdict_word}})
{{pr.url}}
{{review.summary}}
Requirements: {{t.coverage.met}} of {{t.coverage.total}} met - {{t.reproduced.length}} reproduced, {{t.unproven.length}} unproven

{{#t.reproduced}}
- {{severity}} {{id}}: {{title}}
{{/t.reproduced}}
{{#t.findings}}
- {{severity}} {{id}} {{path}}{{#line}}:{{line}}{{/line}}: {{title}}
{{/t.findings}}
