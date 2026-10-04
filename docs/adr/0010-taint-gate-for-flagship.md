# ADR-10: The flagship's Slack post passes the taint rule through a CEL guard

Status: accepted as the plan's default; confirm in spec v2.1

The weekly quality report's `analyse` node ingests untrusted tool output, so it is tainted, and its
output reaches the `post` notify node, a write. The spec's example has no gate and would be rejected by
its own compiler. The flagship package declares a CEL guard on the notify node:

```yaml
guard: "args.channel == config.team_channel"
```

The compiler accepts a write after a tainted node only when an approval node precedes it, a CEL guard
is declared on it, or the tool is marked `safe_for_tainted` by an administrator.
