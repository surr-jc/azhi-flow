*{{summary.headline}}*
{{#summary.prd_title}}
Release plan: {{summary.prd_title}}
{{/summary.prd_title}}

Stories ({{summary.signed_off}} of {{summary.total}} signed off)
{{#summary.stories}}
• {{ref}} {{title}}: {{status}}{{#reason}} ({{reason}}){{/reason}}
{{/summary.stories}}
{{^summary.stories}}
No Story was delivered.
{{/summary.stories}}

Pull request stack, merge them in this order:
{{#summary.stack}}
• {{label}} {{title}} {{pr_url}} ({{branch}})
{{/summary.stack}}
{{^summary.stack}}
No pull request is ready to merge.
{{/summary.stack}}
{{#summary.breakdown_path}}
No tracker was used: the breakdown of the release is in the first pull request ({{summary.breakdown_path}}).
{{/summary.breakdown_path}}

Release check: {{summary.release.status}}{{#summary.release.counts}} ({{pass}} passed, {{fail}} failed, {{unavailable}} unavailable){{/summary.release.counts}}
{{#summary.stopped_at}}
Stopped at: {{summary.stopped_at}}
{{/summary.stopped_at}}
Nothing was merged.
