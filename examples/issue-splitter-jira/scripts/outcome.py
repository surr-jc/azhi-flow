"""Writes what happened, in words: the Slack message, and the comment left on the parent issue.

Reads JSON on stdin: the mode, the ticket label, the parent, the issues created (null for slots that did not
run), the single issue, the comment and label results, and the Jira address. Everything comes from tool outputs.
"""
import json
import re
import sys

KEY = re.compile(r"^[A-Z][A-Z0-9_]*-\d+$")


def key_of(v):
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return None
    if isinstance(v, dict):
        k = v.get("key")
        return k if isinstance(k, str) and KEY.match(k) else key_of(v.get("issue"))
    return None


d = json.load(sys.stdin)
mode, label, parent = d["mode"], d["label"], d.get("parent")
base = (d.get("jira_url") or "").rstrip("/")
made = lambda outs: [{"key": k, "title": (o.get("summary") or (o.get("issue") or {}).get("summary") or "") if isinstance(o, dict) else "", "url": f"{base}/browse/{k}"} for o in outs if o and (k := key_of(o))]
created = made(d.get("created", []))
line = lambda c: f"{c['key']} ({c['url']})" + (f" {c['title']}" if c["title"] else "")
out = {"message": "", "parent_comment": "", "parent_key": parent["key"] if parent else "", "created": created}

if mode in ("split_existing", "split_new"):
    target = parent["key"] + (" (created for this request)" if parent["created"] else "")
    out["message"] = f"Split {label} into {len(created)} sub-task(s) under {target}:\n" + "\n".join(f"• {line(c)}" for c in created)
    out["parent_comment"] = "Split into sub-tasks by Azhi Flow, after a person approved the plan:\n" + "\n".join(f"- {c['key']}" + (f" {c['title']}" if c["title"] else "") for c in created)
    if d.get("dropped"):
        note = f"Left out at the approval: slice {', '.join(str(i) for i in d['dropped'])}."
        out["message"] += "\n" + note
        out["parent_comment"] += "\n\n" + note
elif mode == "single_existing":
    out["message"] = f"{label} fits one pull request: left a scope comment and updated its labels."
elif mode == "single_new":
    s = made([d.get("single")])
    out["message"] = f"Created {line(s[0])} from the request." if s else "Nothing was created."
else:
    out["message"] = f"Nothing was created for {label}: every slice was left out at the approval."
print(json.dumps(out))
