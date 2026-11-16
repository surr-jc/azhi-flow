"""Normalizes the epic text into one plain ticket for the analyst.

Reads JSON on stdin: {repo, text}. There is no issue to read: the text is the whole request. The title is the
first non-empty line, cut, with control characters and angle brackets removed, because it is repeated in the
approval message and in Slack. The description is kept as typed.
"""
import json
import re
import sys

d = json.load(sys.stdin)
text = (d.get("text") or "").strip()
if not text:
    raise SystemExit("give the epic as text to analyze")
first = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
title = re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f<>]", " ", first)).strip()[:120] or "Epic"
print(json.dumps({"kind": "text", "key": "", "number": 0, "title": title, "description": text, "labels": [], "url": "", "comments": []}))
