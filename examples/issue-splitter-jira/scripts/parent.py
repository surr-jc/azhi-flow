"""Names the parent every slice goes under: the issue the run started from, or the umbrella it created.

Reads JSON on stdin: {issue (the input key, empty for free text), created (the umbrella's create-issue output,
or null), jira_url}. A Jira MCP server answers with the issue as an object or as JSON text, sometimes wrapped
in {"issue": {...}}.
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
base = (d.get("jira_url") or "").rstrip("/")
if d.get("created"):
    key = key_of(d["created"])
    if not key:
        raise SystemExit("the umbrella issue was created, but its key could not be read from the answer")
    out = {"key": key, "url": f"{base}/browse/{key}", "created": True}
else:
    key = (d.get("issue") or "").strip()
    if not KEY.match(key):
        raise SystemExit("no parent issue: neither an issue was given nor an umbrella created")
    out = {"key": key, "url": f"{base}/browse/{key}", "created": False}
print(json.dumps(out))
