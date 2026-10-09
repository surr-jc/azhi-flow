*{{ticket.key}} is not ready to build: {{ticket.title}}*

{{dor.summary}}
{{#failed}}
• {{gate}} ({{status}}, {{confidence}} confidence): {{finding}}{{#question}} Question: {{question}}{{/question}}
{{/failed}}

Nothing was built. Answer the questions on the ticket and start the run again.
