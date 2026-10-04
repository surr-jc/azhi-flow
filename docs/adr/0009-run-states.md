# ADR-09: Canonical run state machine

Status: proposed (the spec's diagram was not in the exported text; this fills it)

Four live states and five terminal states. Every run ends in exactly one terminal state; uncertainty
lives in flags beside the state.

| State | Kind | Meaning |
|-------|------|---------|
| `queued` | live | Created and accepted; interpreter not yet started |
| `running` | live | Interpreter is executing nodes |
| `waiting` | live | Blocked on `waiting_reason`: `approval`, `external_event` or `worker_offline`, each with an expiry |
| `cancelling` | live | Cancel requested; stopping processes and sessions |
| `succeeded` | terminal | All nodes finished and every delivery confirmed |
| `delivery_failed` | terminal | Computation succeeded but a notify delivery failed ("Done, delivery failed"); can be redelivered without recomputing |
| `failed` | terminal | A node failed after its retries |
| `cancelled` | terminal | Cancel completed (may carry `termination_unconfirmed`) |
| `expired` | terminal | A wait passed its expiry (approval, external event, or worker offline) |

Allowed transitions: `queued -> running | cancelling`, `running -> waiting | cancelling | <terminal>`,
`waiting -> running | cancelling | expired`, `cancelling -> cancelled`.

Flags: `waiting_reason`, `termination_unconfirmed`, `interrupted_sessions`, `usage_incomplete`.
