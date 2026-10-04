# Architecture decision records

ADR-01 to ADR-06 are taken from Product Specification v2.0, section 6. Later ADRs are recorded here as
they are made.

| ADR | Decision |
|-----|----------|
| 01 | Temporal is the only durable engine; interpreter code is versioned; phase-0 kill criteria ([results](../phase-0-results.md): not triggered) |
| 02 | CEL for all expressions; no JavaScript eval anywhere; same evaluator in compiler and runtime |
| 03 | PostgreSQL only; no Redis, vector DB or queue until a measured bottleneck |
| 04 | Node for the platform; Bun only as a script runtime |
| 05 | The model agent is the default executor |
| 06 | Packages are signed and hashed; credentials never enter packages |
| [07](0007-interpreter-versioning.md) | Interpreter versioning by task queue |
| [08](0008-cel-now.md) | `now` in CEL is pinned per run |
| [09](0009-run-states.md) | Canonical run state machine |
| [10](0010-taint-gate-for-flagship.md) | The flagship's Slack post passes the taint rule through a CEL guard |
| [11](0011-per-publisher-signing-keys.md) | Per-publisher signing keys under a workspace root |
