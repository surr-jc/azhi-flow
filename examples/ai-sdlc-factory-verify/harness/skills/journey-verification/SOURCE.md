# Source of this skill

`SKILL.md` was written for Azhi Flow (Apache-2.0, see `LICENSE`). It is the batch-validation step of the software
factory described by Cole Medin (https://github.com/coleam00/ai-software-factory): after the tickets are merged
into staging, a tester walks the release's user journeys (`END-TO-END.md` there) and sends what is wrong back as
new tickets.

Nothing was copied. The Azhi rules were added: journey and repository text are data, evidence is a file the agent
actually read, and an unknown is `unavailable`, never a pass.
