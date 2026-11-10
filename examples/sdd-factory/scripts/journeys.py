"""The release's user journeys and invariants as one text for the release check. Reads JSON on stdin, prints JSON.

Input:  prd, the approved release plan {journeys: [{name, steps}], invariants: [text]}.
Output: {text, count}. text is the journeys and the invariants as plain Markdown, cut to the 12000 characters the check
        accepts; count is how many journeys and invariants it holds. With none, count is 0 and text is empty.
The plan is untrusted data: it is only read, never run.
"""
import json
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

MAX = 12000


def one_line(value):
    return " ".join(value.split()) if isinstance(value, str) else ""


def decide(prd):
    journeys = []
    listed = prd.get("journeys")
    for j in listed if isinstance(listed, list) else []:
        if not isinstance(j, dict):
            continue
        name = one_line(j.get("name"))
        raw_steps = j.get("steps")
        steps = [one_line(s) for s in raw_steps if isinstance(s, str)] if isinstance(raw_steps, list) else []
        steps = [s for s in steps if s]
        if name and steps:
            journeys.append(f"- {name}: " + " -> ".join(steps))
    raw = prd.get("invariants")
    invariants = [f"- {one_line(i)}" for i in raw if one_line(i)] if isinstance(raw, list) else []
    count = len(journeys) + len(invariants)
    if not count:
        return {"text": "", "count": 0}
    parts = []
    if journeys:
        parts.append("User journeys:\n" + "\n".join(journeys))
    if invariants:
        parts.append("Invariants (must stay true):\n" + "\n".join(invariants))
    return {"text": "\n\n".join(parts)[:MAX], "count": count}


payload = json.load(sys.stdin)
prd = payload.get("prd") if isinstance(payload, dict) else None
print(json.dumps(decide(prd if isinstance(prd, dict) else {})))
