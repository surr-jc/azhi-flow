*Review of {{pr.repo}}#{{pr.number}}: {{pr.title}}*

Verdict: {{review.verdict}}. {{review.summary}}
Head {{pr.head_sha}} against {{pr.base_ref}} ({{pr.base_sha}}), {{pr.additions}} additions and {{pr.deletions}} deletions.

{{#review.findings}}
– {{severity}} ({{reviewer}}) {{path}}{{#line}}:{{line}}{{/line}}: {{title}}. {{detail}}
{{/review.findings}}
