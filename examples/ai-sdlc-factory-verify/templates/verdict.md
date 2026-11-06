*Release verification of {{s.repo}} ({{s.staging_branch}}): {{s.overall}}*

CI on the branch: {{s.ci_status}}. {{s.counts.pass}} passed, {{s.counts.fail}} failed, {{s.counts.unavailable}} unavailable.

{{#s.items}}
- {{kind}} {{title}}: {{status}}
{{/s.items}}

This is a read of the code ({{s.method}}), not a test run. Unavailable items could not be checked and are not counted as passing.
{{#s.propose_fix}}
Something failed. One fix ticket is proposed and waits for approval.
{{/s.propose_fix}}
