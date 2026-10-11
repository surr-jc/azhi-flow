"""Turns the approved plan into the Jira issues to write.

Reads JSON on stdin: the weight route (single or split), the ticket, the analysis, the approver's `drop`
(slice numbers to leave out) and the two labels. Titles, descriptions and the additional-fields JSON are
assembled here (with json.dumps, so no label or title can break the JSON) and not by an agent step.
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
bullets = lambda items: "\n".join(f"- {c}" for c in items) or "- (see the summary)"
clip = lambda s, n: s if len(s) <= n else s[: n - 1] + "…"


def issue(title, body, names):
    # `fields` is the whole additional-fields JSON; `fields_tail` continues after a parent key the workflow adds.
    return {"title": clip(title, 240), "body": body, "fields": json.dumps({"labels": names}) if names else "{}", "fields_tail": ("," + json.dumps("labels") + ":" + json.dumps(names) if names else "") + "}"}


empty = issue("", "", [])
out = {"mode": "none", "label": label, "comment": "", "labels_fields": json.dumps({"labels": []}), "single": empty, "umbrella": empty, "issues": [], "dropped": []}

if d["weight"] == "split":
    slices = a["slices"]
    drop = {int(n) for n in re.findall(r"\d+", d.get("drop") or "")}
    out["dropped"] = sorted(n for n in drop if 1 <= n <= len(slices))
    keep = [(i, s) for i, s in enumerate(slices, 1) if i not in drop]
    names = {i: s["title"] for i, s in enumerate(slices, 1)}
    for i, s in keep:
        deps = [f"slice {n}: {names[n]}" + (" (left out of this plan)" if n in drop else "") for n in s["depends_on"] if n in names]
        order = f"Slice {i} of {len(slices)}. " + (f"Depends on {'; '.join(deps)}. Do not start it before those are done." if deps else "Independent: it can be built on its own.")
        body = f"{s['summary']}\n\n## Acceptance criteria\n{bullets(s['acceptance_criteria'])}\n\n## Surface\n{s['surface']}\n\n## Order\n{order}\n\nSuggested review path: {s['weight']}."
        out["issues"].append(issue(s["title"], body, labels(split_label, ready)))
    if existing:
        out["mode"] = "split_existing" if keep else "none"
    else:
        out["mode"] = "split_new" if keep else "none"
        u = a["umbrella"]
        out["umbrella"] = issue(u["title"] or ticket["title"], f"{u['body']}\n\nThis issue tracks the work below. Each slice is a sub-task.\n\n## Original request\n{clip(ticket['description'], 3000)}", labels(split_label))
else:
    s = a["single"]
    if existing:
        out["mode"] = "single_existing"
        out["labels_fields"] = json.dumps({"labels": sorted(set(ticket["labels"]) | set(labels(ready)))})
        out["comment"] = (
            f"### Scope check\n{a['summary']}\n\nThis fits one pull request: {len(a['deliverables'])} deliverable(s), about {a['est_files']} file(s), "
            f"risk {a['risk']}. Acceptance criteria as analyzed:\n{bullets(s['acceptance_criteria'])}" + (f"\n\nLabelled `{ready}`." if ready else "")
        )
    else:
        out["mode"] = "single_new"
        out["single"] = issue(s["title"] or ticket["title"], f"{s['body']}\n\n## Acceptance criteria\n{bullets(s['acceptance_criteria'])}\n\n## Original request\n{clip(ticket['description'], 3000)}", labels(ready))
print(json.dumps(out))
