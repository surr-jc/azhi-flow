*Root-cause analysis of {{issue.repo}}#{{issue.number}}: {{issue.title}}*

{{rca.summary}}

Severity: {{rca.assessment.severity}} ({{rca.assessment.severity_reason}})
Complexity: {{rca.assessment.complexity}} ({{rca.assessment.complexity_reason}})
Confidence: {{rca.assessment.confidence}} ({{rca.assessment.confidence_reason}})
Origin: {{rca.origin}}{{#rca.origin_detail}}. {{rca.origin_detail}}{{/rca.origin_detail}}

Root cause: {{rca.root_cause}}

Evidence:
{{#rca.evidence}}
– Why {{why}}? Because {{because}} ({{path}}{{#line}}:{{line}}{{/line}})
{{/rca.evidence}}

Proposed fix: {{rca.fix.strategy}}
{{#rca.fix.files}}
– {{path}}: {{change}}
{{/rca.fix.files}}
{{#rca.fix.alternatives}}
Alternatives: {{rca.fix.alternatives}}
{{/rca.fix.alternatives}}
{{#rca.fix.risks}}
– Risk: {{.}}
{{/rca.fix.risks}}

Tests to add:
{{#rca.tests}}
– {{.}}
{{/rca.tests}}
{{#rca.out_of_scope}}
– Out of scope: {{.}}
{{/rca.out_of_scope}}
