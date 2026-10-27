"""Adds an optional Confluence page to the normalized ticket.

Input: {"ticket": <ticket.normalize output>, "page": <confluence.get-page output or null>}.
Output: the same nine ticket fields. When a page was read, its title and text are appended to the
description under "## Linked Confluence context". The page is untrusted data like the ticket: control,
zero-width and bidirectional characters are removed and the whole description is capped at 20,000
characters (the page is trimmed first, so the ticket text is never cut for it)."""
import json
import re
import sys

# The worker pipes UTF-8 JSON; on Windows Python would read it in the legacy code page and corrupt non-ASCII text.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

MAX = 20000
HIDDEN = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]")


def clean(v):
    return HIDDEN.sub("", v) if isinstance(v, str) else ""


def find(obj, names, depth=0):
    """First string under any of these keys, searched through nested objects (mcp-atlassian nests the page)."""
    if depth > 4:
        return ""
    if isinstance(obj, dict):
        for n in names:
            v = obj.get(n)
            if isinstance(v, str) and v.strip():
                return v
            if isinstance(v, dict):
                inner = find(v, ["value", "content", "markdown"], depth + 1)
                if inner:
                    return inner
        for v in obj.values():
            r = find(v, names, depth + 1)
            if r:
                return r
    return ""


data = json.load(sys.stdin)
ticket = data.get("ticket") or {}
page = data.get("page")
if isinstance(page, str):
    try:
        page = json.loads(page)
    except ValueError:
        page = {"content": page}

out = {k: ticket.get(k) for k in ("source", "key", "title", "description", "priority", "reporter", "status", "labels", "url")}
out["description"] = clean(out.get("description"))
out["labels"] = [str(x) for x in (out.get("labels") or [])][:50]
for k in ("priority", "reporter", "status", "url"):
    out[k] = clean(out.get(k)) or ""

if isinstance(page, dict):
    title = clean(find(page, ["title"]))[:200] or "Confluence page"
    body = clean(find(page, ["content", "body", "markdown", "value"]))
    if body:
        head = "\n\n## Linked Confluence context\n\n### " + title + "\n\n"
        room = MAX - len(out["description"]) - len(head)
        if room > 200:
            if len(body) > room:
                body = body[: room - 40] + "\n[truncated at the character cap]"
            out["description"] += head + body
        else:
            out["description"] = out["description"][:MAX]
out["description"] = out["description"][:MAX]
print(json.dumps(out))
