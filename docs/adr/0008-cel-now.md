# ADR-08: `now` in CEL is pinned per run

Status: accepted (phase 0, spike 4)

`now` is not standard CEL and wall-clock time would break Temporal replay. Every run's configuration
snapshot carries `reference_time`: the scheduled occurrence time for scheduled runs, or the creation
time for manual and API runs. CEL expressions see it as `now` (a timestamp). Reruns from checkpoint
take a new reference time; resumes keep the original.
