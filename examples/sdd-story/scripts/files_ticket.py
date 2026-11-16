"""The ticket of a Story that has no tracker (source: files). Reads JSON on stdin, prints JSON.

Input:  {"key": story_key, "title": story_title, "body": story_body}, given by the parent workflow that made them.
Output: the same nine fields ticket.normalize returns: {source, key, title, description, priority, reporter, status,
        labels, url}. source is "files"; priority, reporter, status and url are empty, labels is [].

The title and body are untrusted text (an agent or a person wrote them). The title becomes one line with control
characters and angle brackets replaced by spaces (it can reach Slack), the body keeps its newlines and tabs and loses
every other control character, and both are cut. The key becomes a branch name (azhi/<key>) and a change id, so it must
be lower-case letters, digits and hyphens. Anything invalid stops the Story: the script exits with an error, the run
fails, and a parent treats a failed child as a Story that was not signed off.
"""
import json
import re
import sys

# The worker pipes UTF-8 JSON; on Windows Python would read it in the legacy code page and corrupt non-ASCII text.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

MAX_TITLE = 200
MAX_BODY = 20000
KEY = re.compile(r"[a-z0-9][a-z0-9-]{0,60}")
# C0/C1 controls, zero-width and bidirectional controls, BOM - as ticket.normalize removes them.
HIDDEN_LINE = re.compile("[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]")
# The body keeps a tab (0x09) and a newline (0x0a).
HIDDEN_BODY = re.compile("[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]")


def fail(message):
    raise SystemExit(f"files_ticket: {message}")


data = json.load(sys.stdin)
if not isinstance(data, dict):
    fail("the input is not an object")

key = data.get("key")
if not isinstance(key, str) or not KEY.fullmatch(key):
    fail("story_key must be lower-case letters, digits and hyphens, 1 to 61 characters, starting with a letter or digit")

title = data.get("title")
if not isinstance(title, str):
    fail("story_title is not text")
title = HIDDEN_LINE.sub(" ", title.replace("<", " ").replace(">", " "))
title = re.sub(r"\s+", " ", title).strip()[:MAX_TITLE].strip()
if not title:
    fail("story_title is empty")

body = data.get("body")
if not isinstance(body, str):
    fail("story_body is not text")
body = HIDDEN_BODY.sub("", body.replace("\r\n", "\n").replace("\r", "\n")).strip()[:MAX_BODY]
if not body.strip():
    fail("story_body is empty")

print(json.dumps({
    "source": "files",
    "key": key,
    "title": title,
    "description": body,
    "priority": "",
    "reporter": "",
    "status": "",
    "labels": [],
    "url": "",
}))
