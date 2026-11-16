*{{summary.headline}}* ({{summary.repo}})

{{#summary.prs}}
• #{{number}} {{title}} {{url}}: {{status}}{{#resolution_url}} -> {{resolution_url}}{{/resolution_url}}{{#reason}} ({{reason}}){{/reason}}
{{/summary.prs}}
{{^summary.prs}}
Nothing to resolve.
{{/summary.prs}}
{{#summary.unknown}}
GitHub had not computed mergeability for #{{.}} yet; run the sweep again later.
{{/summary.unknown}}
{{#summary.truncated}}
More conflicting pull requests exist than this run looked at. Raise the limit or run it again.
{{/summary.truncated}}
Nothing was merged, closed or force-pushed.
