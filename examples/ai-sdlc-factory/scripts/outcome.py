"""Reads what the delivery run (sdlc-universal) did with the ticket. Reads JSON on stdin, prints JSON.

Input:  child, the subworkflow output {run_id, state, nodes}, where nodes holds each succeeded step's output.
Output: "shipped" when a pull request was opened, otherwise "sent_back" (the run ended without one: tests failed,
        nothing changed, or a blocker). A run that did not succeed (the delivery node says on_failure: continue) arrives with its state and error class and
        is sent back like any other delivery without a pull request.
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
# A delivery that failed, expired or was rejected has no pull request; the lap carries on so the ticket is sent back
# to its owner. Only the error class is kept: the message can quote ticket text.
child_state = str(child.get("state") or "succeeded")
failure = str((child.get("error") or {}).get("class") or "") if child_state != "succeeded" else ""
print(json.dumps({
    "status": "shipped" if shipped else "sent_back",
    "pr_url": str(pr.get("url") or ""),
    "pr_number": int(pr.get("number") or 0),
    "draft": bool(pr.get("draft")),
    "summary": str(change.get("summary") or ""),
    "tests": str(tests),
    "needs_attention": bool((nodes.get("finalize") or {}).get("needs_human_attention")),
    "run_id": str(child.get("run_id") or ""),
    "child_state": child_state,
    "failure": failure,
}))
