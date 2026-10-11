"""Normalizes the request into one ticket: a GitHub issue (as the get-issue tool returns it) or free text.

Reads JSON on stdin: {repo, text, issue}. An issue wins when both are given. The issue must be in the
repository the run was started for, because every later write is guarded by that repository.
"""
import json
import sys

d = json.load(sys.stdin)
repo, text, issue = d["repo"], (d.get("text") or "").strip(), d.get("issue")

if issue:
    if str(issue.get("repo", "")).lower() != repo.lower():
        raise SystemExit(f"the issue is in {issue.get('repo')}, but this run is for {repo}: start it for the issue's repository")
    out = {
        "kind": "issue",
        "key": f"{repo}#{issue['number']}",
        "number": int(issue["number"]),
        "title": issue.get("title", ""),
        "description": issue.get("body", ""),
        "labels": issue.get("labels", []),
        "url": issue.get("url", ""),
        "comments": [{"author": c.get("author", ""), "body": c.get("body", "")} for c in issue.get("comments", [])],
    }
elif text:
    first = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    out = {"kind": "text", "key": "", "number": 0, "title": first[:120], "description": text, "labels": [], "url": "", "comments": []}
else:
    raise SystemExit("give an issue or a text to analyze")
print(json.dumps(out))
