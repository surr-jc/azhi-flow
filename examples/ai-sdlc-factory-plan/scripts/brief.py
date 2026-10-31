"""Turns the request into one brief for the release planner. Reads JSON on stdin, prints JSON.

Input:  ticket (a ticket as ticket.normalize returns it, or null), goal (free text, may be empty).
Output: the brief's source, key, title and text. A ticket comes first, then any extra direction. The text is data
        for the planner and is cut to fit the splitter's input; nothing in it is run.
"""
import json
import sys

d = json.load(sys.stdin) or {}
t, goal = d.get("ticket"), (d.get("goal") or "").strip()
MAX = 16000

if not t and not goal:
    raise SystemExit("give a ticket or a goal to plan")

parts = []
if t:
    parts.append(f"{t.get('key', '')} {t.get('title', '')}".strip())
    if t.get("description"):
        parts.append(str(t["description"]))
if goal:
    parts.append(("Direction from the requester:\n" if t else "") + goal)
text = "\n\n".join(parts)[:MAX]

first = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
print(json.dumps({
    "kind": "ticket" if t else "text",
    "source": (t or {}).get("source", "text"),
    "key": (t or {}).get("key", ""),
    "title": (t or {}).get("title") or first[:120],
    "text": text,
    "truncated": len("\n\n".join(parts)) > MAX,
}))
