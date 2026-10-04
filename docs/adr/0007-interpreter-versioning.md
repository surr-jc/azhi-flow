# ADR-07: Interpreter versioning by task queue

Status: accepted (phase 0, spike 3)

Each interpreter build has an ID (`AZHI_INTERPRETER_BUILD`, defaulting to the package version plus a
hash of the interpreter source). A build's Temporal worker polls `azhi-interpreter-<build>`. A run is
started on the newest live build's queue and records that build ID, so every later workflow task for
the run goes to the same code. Old builds keep polling until none of their runs are open; then they
are retired. `azhi doctor` fails when more than three builds have open runs.

Consequence: workflow code can change without `patched()` branches. The cost is running more than one
interpreter process during a rollout.
