"""Turns the approved plan into the issues to write.

Reads JSON on stdin: the weight route (single or split), the ticket, the analysis, the approver's `drop`
(slice numbers to leave out), the repository and the two labels. Writes the mode (which branch of the
workflow runs), the labels, and every issue's title and body, so bodies are assembled here, from the
analysis fields, and not by another agent step.
"""
import json
import re
import sys

d = json.load(sys.stdin)
ticket, a = d["ticket"], d["analysis"]
ready, split_label = (d.get("ready_label") or "").strip(), (d.get("split_label") or "").strip()
existing = ticket["kind"] == "issue"
label = ticket["key"] or ticket["title"] or "this request"
labels = lambda *names: [n for n in names if n]


def bullets(items):
    return "\n".join(f"- {c}" for c in items) or "- (see the summary)"


def clip(s, n):
    return s if len(s) <= n else s[: n - 1] + "…"


out = {"mode": "none", "label": label, "ticket_number": ticket["number"], "comment": "", "labels": [], "single": {"title": "", "body": "", "labels": []}, "umbrella": {"title": "", "body": "", "labels": []}, "issues": [], "dropped": []}

if d["weight"] == "split":
    slices = a["slices"]
    drop = {int(n) for n in re.findall(r"\d+", d.get("drop") or "")}
    out["dropped"] = sorted(n for n in drop if 1 <= n <= len(slices))
    keep = [(i, s) for i, s in enumerate(slices, 1) if i not in drop]
    names = {i: s["title"] for i, s in enumerate(slices, 1)}
    # `ready` marks a slice that can be started now: one that waits for another is not ready until that is merged.
    for pos, (i, s) in enumerate(keep, 1):
        deps = [f"slice {n}: {names[n]}" + (" (left out of this plan)" if n in drop else "") for n in s["depends_on"] if n in names]
        order = f"Slice {i} of {len(slices)}. " + (f"Depends on {'; '.join(deps)}. Do not start it before those are merged." if deps else "Independent: it can be built on its own.")
        body = (
            f"{s['summary']}\n\n## Acceptance criteria\n{bullets(s['acceptance_criteria'])}\n\n## Surface\n{s['surface']}\n\n"
            f"## Order\n{order}\n\nSuggested review path: {s['weight']}."
        )
        out["issues"].append({"title": clip(s["title"], 120), "body": body, "labels": labels(split_label, "" if s["depends_on"] else ready)})
    if existing:
        out["mode"] = "split_existing" if keep else "none"
    else:
        out["mode"] = "split_new" if keep else "none"
        u = a["umbrella"]
        out["umbrella"] = {
            "title": clip(u["title"] or ticket["title"], 120),
            "body": f"{u['body']}\n\nThis issue tracks the work below. Each slice is a sub-issue.\n\n## Original request\n{clip(ticket['description'], 3000)}",
            "labels": labels(split_label),
        }
else:
    s = a["single"]
    if existing:
        out["mode"] = "single_existing"
        out["labels"] = labels(ready)
        out["comment"] = (
            f"### Scope check\n{a['summary']}\n\nThis fits one pull request: {len(a['deliverables'])} deliverable(s), about {a['est_files']} file(s), "
            f"risk {a['risk']}. Acceptance criteria as analyzed:\n{bullets(s['acceptance_criteria'])}"
            + (f"\n\nLabelled `{ready}`." if ready else "")
        )
    else:
        out["mode"] = "single_new"
        out["single"] = {
            "title": clip(s["title"] or ticket["title"], 120),
            "body": f"{s['body']}\n\n## Acceptance criteria\n{bullets(s['acceptance_criteria'])}\n\n## Original request\n{clip(ticket['description'], 3000)}",
            "labels": labels(ready),
        }
print(json.dumps(out))
