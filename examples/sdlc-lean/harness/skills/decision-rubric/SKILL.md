---
name: decision-rubric
description: How to write an open question a person can actually decide - problem, what comparable systems do, three or four genuinely different options, a recommendation with the strongest counter-argument, and a question whose first option is the recommendation
---
# Decision rubric

An open question exists so that a person decides, not so that they nod. A question that restates
your preferred answer and asks "do you agree?" turns their decision into a rubber stamp. Use this
format for every item in `open_questions`.

## When to raise a question

Raise one for: a pattern fork (two existing patterns fit), a contract or default that ships to
users, failure behaviour, a library or approach with real trade-offs, anything hard to reverse.
Do not raise one for naming, formatting, or cheap reversible choices: decide those and move on.
Never decide silently something that is legal, money, credentials or an operator-only action: it is
always a question.

## The five parts

Fill these fields of each open question:

1. `question`: the decision in one sentence, with the trade-off axis ("speed vs. safety").
2. `research`: what the repository already does, and what comparable systems do. Cite
   `path:line` for the repository. Do not invent examples you cannot name.
3. `options`: three or four genuinely different choices (not variations), each with `pros`,
   `cons` and a `verdict`. One of them may be your lean, but do not let it anchor the rest.
4. `recommended_default` and `counter_argument`: your pick, then the strongest objection a careful
   engineer would raise against it, and why you still recommend it. If you cannot write a real
   objection, you have not understood the trade-off yet.
5. `why`: the concrete cost of getting it wrong.

## Anti-patterns

- "Do you agree?" framing, or a recommendation only visible in the question text.
- Vague trade-offs ("more flexible", "cleaner") with no cost named.
- Overlapping options; skipping the counter-argument; batching three decisions in one question.

## How the answer is used

A person answers at the design review, one answer per question or "use the recommended defaults".
The engineer treats the answer as binding and records the rationale in the pull request. Keep to at
most six questions; if you have more, you have not decided what you can decide.
