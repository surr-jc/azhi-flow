"""Reads what the delivery run (sdlc-universal) did with the ticket. Reads JSON on stdin, prints JSON.

Input:  child, the subworkflow output {run_id, state, nodes}, where nodes holds each succeeded step's output.
Output: "shipped" when a pull request was opened, otherwise "sent_back" (the run ended without one: tests failed,
        nothing changed, or a blocker). A run that did not succeed at all never gets here; the lap fails with it.
The child's output is untrusted data: it is only read, never run.
"""
import json
import sys

d = json.load(sys.stdin) or {}
child = d.get("child") or {}
nodes = child.get("nodes") or {}
pr = nodes.get("open_pr") or {}
change = ((nodes.get("finalize") or {}).get("change")) or {}
tests = (change.get("tests") or {}).get("status", "unavailable")

shipped = bool(pr.get("url"))
print(json.dumps({
    "status": "shipped" if shipped else "sent_back",
    "pr_url": str(pr.get("url") or ""),
    "pr_number": int(pr.get("number") or 0),
    "draft": bool(pr.get("draft")),
    "summary": str(change.get("summary") or ""),
    "tests": str(tests),
    "needs_attention": bool((nodes.get("finalize") or {}).get("needs_human_attention")),
    "run_id": str(child.get("run_id") or ""),
}))
