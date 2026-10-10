*{{ticket.key}} cannot be built as written: {{ticket.title}}*

{{dor.summary}}
{{#failed}}
• {{gate}} ({{status}}, {{confidence}} confidence): {{finding}}{{#question}} Question: {{question}}{{/question}}
{{/failed}}

Nothing was built, and answering questions will not fix this: the ticket has to change first (split it into one-PR slices, or say what is code and what is not). Then start the run again.
