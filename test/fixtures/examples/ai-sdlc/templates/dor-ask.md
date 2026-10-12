*{{ticket.key}} is waiting for your answers: {{ticket.title}}*

{{dor.summary}}
{{#failed}}
• {{gate}}: {{finding}}{{#question}} Question: {{question}}{{/question}}
{{/failed}}

Nothing is built until someone answers. Answer on the Approvals page of mission control (step "clarification"), with `azhi approve <run> clarification --data '{"answers": "..."}'`, or from the approval message in Slack. Reject to stop. It expires after 72 hours.
