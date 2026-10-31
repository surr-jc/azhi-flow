*Factory lap for {{repo}}*: {{pick.ticket.key}} {{pick.ticket.title}} ({{pick.reason}})

{{#shipped}}
Pull request into {{staging_branch}}: {{outcome.pr_url}}{{#outcome.draft}} (draft){{/outcome.draft}}. {{outcome.summary}}
{{#outcome.needs_attention}}Reviewers still have findings: needs human attention.{{/outcome.needs_attention}}
Merging it into {{staging_branch}} is a person's decision.
{{/shipped}}
{{^shipped}}
Sent back without a pull request (tests: {{outcome.tests}}). The ticket is marked for its owner and the next lap skips it.
{{/shipped}}
{{#pick.skipped}}
- skipped {{key}}: {{why}}
{{/pick.skipped}}
