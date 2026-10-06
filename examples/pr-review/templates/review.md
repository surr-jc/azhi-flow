*Review of {{pr.repo}}#{{pr.number}}: {{pr.title}}*

{{#merge.conflicts}}
Merge status: CONFLICTS with {{pr.base_ref}} - rebase or merge {{pr.base_ref}} into the branch before this can merge.
{{/merge.conflicts}}
{{#merge.behind}}
Merge status: behind {{pr.base_ref}} - update the branch.
{{/merge.behind}}
{{#merge.blocked}}
Merge status: blocked by branch rules (required reviews or checks).
{{/merge.blocked}}
{{#merge.unknown}}
Merge status: UNKNOWN - GitHub had not computed mergeability, so conflicts were not checked.
{{/merge.unknown}}

Verdict: {{review.verdict}}. {{review.summary}}
Head {{pr.head_sha}} against {{pr.base_ref}} ({{pr.base_sha}}), {{pr.additions}} additions and {{pr.deletions}} deletions.

{{#review.findings}}
– {{severity}} ({{reviewer}}) {{path}}{{#line}}:{{line}}{{/line}}: {{title}}. {{detail}}
{{/review.findings}}
