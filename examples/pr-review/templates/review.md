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

{{#triage.fix_now.length}}
Fix now:
{{/triage.fix_now.length}}
{{#triage.fix_now}}
– {{severity}} ({{reviewer}}) {{path}}{{#line}}:{{line}}{{/line}}: {{title}}. {{detail}}
{{/triage.fix_now}}
{{#triage.follow_up.length}}
Follow-up issue:
{{/triage.follow_up.length}}
{{#triage.follow_up}}
– {{severity}} ({{reviewer}}) {{path}}{{#line}}:{{line}}{{/line}}: {{title}}. {{detail}}
{{/triage.follow_up}}
{{#triage.check_by_hand.length}}
Check by hand:
{{/triage.check_by_hand.length}}
{{#triage.check_by_hand}}
– {{severity}} ({{reviewer}}) {{path}}{{#line}}:{{line}}{{/line}}: {{title}}. {{detail}}
{{/triage.check_by_hand}}
