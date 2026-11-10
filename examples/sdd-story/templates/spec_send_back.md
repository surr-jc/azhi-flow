*{{ticket.key}}: the {{stage}} did not pass its check, so nothing was built or pushed* ({{ticket.title}})
{{#errors}}
• {{.}}
{{/errors}}
{{#warnings}}
– Warning: {{.}}
{{/warnings}}

Fix the ticket or the specs named above and start the run again.
