*Weekly quality report: {{team}}*
{{a.headline}}

• Pass rate {{m.pass_rate_pct}}% ({{m.pass_rate_delta_pct}} pts week over week), {{m.passed}} of {{m.runs}} main runs
• Flake rate {{m.flake_rate_pct}}% ({{m.flake_rate_delta_pct}} pts); {{m.flaky_tests}} flaky tests, {{m.quarantined}} quarantined
• Mean time to green {{m.mttg_hours}} h ({{m.mttg_delta_hours}} h)
• Open incidents: {{m.open_incidents}}

{{#a.points}}
– {{text}} {{#citations}}[{{.}}]{{/citations}}
{{/a.points}}
{{#a.insufficient_evidence}}
_The analyst flagged insufficient evidence for part of this explanation._
{{/a.insufficient_evidence}}

{{#citations}}
[{{n}}] {{document}} › {{heading}} ({{dataset}}@{{revision}})
{{/citations}}

{{#as_of}}
_{{source}} data as of {{observed_at}}_
{{/as_of}}
