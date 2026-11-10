"""Turns the approved plan into the Stories, in delivery order.

Reads JSON on stdin: the weight route (single or split), the ticket, the analysis and the approver's `drop`
(slice numbers from the plan to leave out). Writes the kept slices renumbered 1..N in the analyst's order,
each with a title and a Markdown body assembled here from the analysis fields, and not by another agent step.
Dependency notes use the new numbers; a dependency that was left out is named without a number.
"""
import json
import re
import sys

MAX_SLICES = 6

d = json.load(sys.stdin)
ticket, a = d["ticket"], d["analysis"]


def bullets(items):
    return "\n".join(f"- {c}" for c in items) or "- (see the goal)"


def clip(s, n):
    return s if len(s) <= n else s[: n - 1] + "…"


epic_title = clip(((a.get("umbrella") or {}).get("title") if d["weight"] == "split" else "") or ticket["title"], 120)
out = {"mode": "none", "epic_title": epic_title, "dropped": [], "stories": []}

if d["weight"] == "split":
    slices = a["slices"][:MAX_SLICES]
    drop = {int(n) for n in re.findall(r"\d+", (d.get("drop") or "")[:40])}
    out["dropped"] = sorted(n for n in drop if 1 <= n <= len(slices))
    keep = [(i, s) for i, s in enumerate(slices, 1) if i not in drop]
    new = {i: pos for pos, (i, _) in enumerate(keep, 1)}
    titles = {i: s["title"] for i, s in enumerate(slices, 1)}
    for pos, (i, s) in enumerate(keep, 1):
        deps = [n for n in s["depends_on"] if n in titles and n != i]
        notes = [f"slice {new[n]}: {titles[n]}" if n in new else f"{titles[n]} (left out of this plan)" for n in deps]
        order = f"Slice {pos} of {len(keep)}. " + (f"Depends on {'; '.join(notes)}. Do not start it before those are delivered." if notes else "Independent: it can be built on its own.")
        body = (
            f"## Goal\n{s['summary']}\n\n## Scope\n{s['surface']}\n\n## Acceptance criteria\n{bullets(s['acceptance_criteria'])}\n\n"
            f"## Order\n{order}\n\nSuggested review path: {s['weight']}."
        )
        out["stories"].append({"slice": pos, "title": clip(s["title"], 200), "body": body})
else:
    s = a["single"]
    body = f"## Goal\n{s['body']}\n\n## Acceptance criteria\n{bullets(s['acceptance_criteria'])}\n\n## Order\nSlice 1 of 1. Independent: the whole epic is one Story."
    out["stories"].append({"slice": 1, "title": clip(s["title"] or ticket["title"], 200), "body": body})

out["mode"] = "ok" if out["stories"] else "none"
print(json.dumps(out))
