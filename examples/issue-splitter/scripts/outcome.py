"""Writes what happened, in words: the Slack message, and the comment left on the parent issue.

Reads JSON on stdin: the mode, the ticket label, the parent, the issues created (null for slots that did
not run), the single issue, and the comment and label results. Everything comes from tool outputs.
"""
import json
import sys

d = json.load(sys.stdin)
mode, label, parent = d["mode"], d["label"], d.get("parent")
created = [c for c in d.get("created", []) if c]
unlinked = [c for c in created if not c.get("linked")]
line = lambda c: f"#{c['number']} {c['title']} ({c['url']})"
out = {"message": "", "parent_comment": "", "parent_number": parent["number"] if parent else 0, "created": [{"number": c["number"], "title": c["title"], "url": c["url"], "linked": bool(c.get("linked"))} for c in created]}

if mode in ("split_existing", "split_new"):
    n = len(created)
    target = f"#{parent['number']}" + (" (created for this request)" if parent["created"] else "")
    out["message"] = f"Split {label} into {n} issue(s) under {target}:\n" + "\n".join(f"• {line(c)}" for c in created)
    out["parent_comment"] = "Split into sub-issues by Azhi Flow, after a person approved the plan:\n" + "\n".join(f"- #{c['number']} {c['title']}" for c in created)
    if d.get("dropped"):
        out["message"] += f"\nLeft out at the approval: slice {', '.join(str(i) for i in d['dropped'])}."
        out["parent_comment"] += f"\n\nLeft out at the approval: slice {', '.join(str(i) for i in d['dropped'])}."
    if unlinked:
        note = "Not linked as sub-issues (GitHub refused; each carries a 'Part of' line instead): " + ", ".join(f"#{c['number']}" for c in unlinked)
        out["message"] += "\n" + note
        out["parent_comment"] += "\n\n" + note
elif mode == "single_existing":
    labelled = (d.get("labelled") or {}).get("labels", [])
    out["message"] = f"{label} fits one pull request: left a scope comment" + (f" and added the labels {', '.join(labelled)}." if labelled else ".")
elif mode == "single_new":
    s = d.get("single")
    out["message"] = f"Created {line(s)} from the request." if s else "Nothing was created."
else:
    out["message"] = f"Nothing was created for {label}: every slice was left out at the approval."
print(json.dumps(out))
