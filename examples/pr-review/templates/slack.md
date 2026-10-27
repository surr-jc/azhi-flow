{{#merge.conflicts}}
:warning: Merge conflicts with the base branch.
{{/merge.conflicts}}
*PR review: {{pr.repo}}#{{pr.number}} {{pr.title}}* - {{review.verdict}}
{{pr.url}}
{{review.summary}}

{{#review.findings}}
- {{severity}} ({{reviewer}}) {{path}}{{#line}}:{{line}}{{/line}}: {{title}}
{{/review.findings}}
