*Factory readiness for {{s.repo}} ({{s.base_branch}}): {{s.level}}*

{{#s.checks}}
- {{title}}: {{status}}
{{/s.checks}}

{{#s.has_unavailable}}
Checks marked unavailable could not be read; they are not counted as passing.
{{/s.has_unavailable}}
{{#s.propose_fix}}
CI is red on {{s.base_branch}} and no ticket is open for it. A fix ticket is proposed and waits for approval.
{{/s.propose_fix}}
