"""Normalizes the request into one ticket: a Jira issue (as ticket.normalize returns it) or free text.

Reads JSON on stdin: {normalized, text, project}. An issue wins when both are given. The project every
issue is created in is the issue's own project, or the one named for a text request, and every later
write is guarded by it.
"""
import json
import re
import sys

KEY = re.compile(r"^[A-Z][A-Z0-9_]*-\d+$")
PROJECT = re.compile(r"^[A-Z][A-Z0-9_]+$")
d = json.load(sys.stdin)
n, text, project = d.get("normalized"), (d.get("text") or "").strip(), (d.get("project") or "").strip()

if n:
    if not KEY.match(n.get("key", "")):
        raise SystemExit(f"not a Jira issue key: {n.get('key')!r}")
    out = {"kind": "issue", "key": n["key"], "number": 0, "project": n["key"].rsplit("-", 1)[0], "title": n.get("title", ""), "description": n.get("description", ""), "labels": n.get("labels", []), "url": n.get("url", ""), "comments": []}
elif text:
    if not PROJECT.match(project):
        raise SystemExit("name the Jira project (for example PAY) to create issues from a text request")
    first = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    out = {"kind": "text", "key": "", "number": 0, "project": project, "title": first[:120], "description": text, "labels": [], "url": "", "comments": []}
else:
    raise SystemExit("give an issue or a text to analyze")
print(json.dumps(out))
