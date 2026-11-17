"""Normalizes the requirement into one ticket: an issue (as ticket.normalize returns it), typed text, or - when
neither was given - the pull request's own title and description.

Reads JSON on stdin: {normalized, comments, text, pr}. Precedence: an issue, then the text, then the PR.
Everything here is text people wrote: it is capped and passed on as data, never run.
"""
import json
import re
import sys

d = json.load(sys.stdin)
n, text, pr = d.get("normalized"), (d.get("text") or "").strip(), d.get("pr") or {}


def cap(s, n_):
    return (s or "")[:n_]


def shown(s):
    """The title as it may appear in a PR comment: one line, no backticks, no @ that could mention someone."""
    return re.sub(r"\s+", " ", s or "").replace("`", "'").replace("@", "@​").strip()[:200]


comments = [{"author": cap(c.get("author"), 80), "body": cap(c.get("body"), 2000)} for c in (d.get("comments") or [])[:10] if isinstance(c, dict)]

if n:
    source = n.get("source") if n.get("source") in ("github", "jira") else "github"
    out = {"origin": "issue", "source": source, "key": cap(n.get("key"), 80), "title": cap(n.get("title"), 200), "description": cap(n.get("description"), 20000), "labels": [cap(x, 80) for x in (n.get("labels") or [])[:50]], "url": cap(n.get("url"), 300), "comments": comments}
elif text:
    first = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    out = {"origin": "text", "source": "text", "key": "", "title": cap(first, 200), "description": cap(text, 20000), "labels": [], "url": "", "comments": []}
else:
    out = {"origin": "inferred", "source": "pr", "key": "", "title": cap(pr.get("title"), 200), "description": cap(pr.get("body"), 20000), "labels": [], "url": cap(pr.get("url"), 300), "comments": []}
out["shown_title"] = shown(out["title"])
print(json.dumps(out))
