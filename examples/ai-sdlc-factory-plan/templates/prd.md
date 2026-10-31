# {{prd.title}}

{{prd.summary}}

**Owner:** {{#prd.owner.value}}{{prd.owner.value}}{{/prd.owner.value}}{{^prd.owner.value}}unknown{{/prd.owner.value}} ({{prd.owner.evidence}})

## Problem
{{prd.problem}}

## Goals
{{#prd.goals}}
- {{.}}
{{/prd.goals}}

## Non-goals
{{#prd.non_goals}}
- {{.}}
{{/prd.non_goals}}

## Invariants
{{#prd.invariants}}
- {{.}}
{{/prd.invariants}}

## User journeys
{{#prd.journeys}}
- **{{name}}**
{{#steps}}
  - {{.}}
{{/steps}}
{{/prd.journeys}}

## Walking skeleton
{{prd.walking_skeleton}}

## Epics
{{#prd.epics}}
- **{{title}}**: {{goal}}
{{/prd.epics}}

## Risks
{{#prd.risks}}
- {{.}}
{{/prd.risks}}

## Open questions
{{#prd.open_questions}}
- {{.}}
{{/prd.open_questions}}
