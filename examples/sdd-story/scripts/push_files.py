"""The files of a push: the agent's files plus the extra files the pull request adds (the release breakdown
document). Reads JSON on stdin, prints JSON.

Input:  {"agent_files": [...the workspace files...], "extra_files": [{path, content}, ...] or null}.
Output: {"files": [...], "ignored": [...paths]}.

Each valid extra becomes {path, status: "added", content, encoding: "utf-8"}. An agent file at the same path is
dropped: the extra wins. An extra is valid when its path matches docs/release/<name>/<file>.md with no "..", its
content is text of at most 60000 characters, and its path was not given before. Rules for the whole list:
  - more than 3 extras: none is pushed and every one is ignored;
  - the push tool takes at most 300 files: when the agent files and the valid extras together would be more, none of
    the extras is pushed and all are ignored.
An ignored extra is listed by path only (cleaned, cut to 200 characters); a documentation file never fails the Story.
The agent files are passed on unchanged. An agent_files that is not a list stops the script.
"""
import json
import re
import sys

# The worker pipes UTF-8 JSON; on Windows Python would read it in the legacy code page and corrupt non-ASCII text.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

MAX_EXTRAS = 3
MAX_CONTENT = 60000
MAX_FILES = 300
PATH = re.compile(r"docs/release/[a-z0-9][a-z0-9-]{0,60}/[A-Za-z0-9._-]{1,80}\.md")
UNPRINTABLE = re.compile("[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]")


def listed(value):
    """A path as it is reported: text only, printable, cut."""
    if not isinstance(value, str):
        return "(no path)"
    return UNPRINTABLE.sub(" ", value)[:200] or "(no path)"


def valid(extra):
    return (
        isinstance(extra, dict)
        and isinstance(extra.get("path"), str)
        and PATH.fullmatch(extra["path"]) is not None
        and ".." not in extra["path"]
        and isinstance(extra.get("content"), str)
        and len(extra["content"]) <= MAX_CONTENT
    )


data = json.load(sys.stdin)
if not isinstance(data, dict) or not isinstance(data.get("agent_files"), list):
    raise SystemExit("push_files: agent_files is not a list")
agent_files = data["agent_files"]
extras = data.get("extra_files")
if extras is None:
    extras = []
if not isinstance(extras, list):
    print(json.dumps({"files": agent_files, "ignored": ["(extra_files is not a list)"]}))
    raise SystemExit(0)

if len(extras) > MAX_EXTRAS:
    print(json.dumps({"files": agent_files, "ignored": [listed(e.get("path") if isinstance(e, dict) else None) for e in extras][:50]}))
    raise SystemExit(0)

pushed, ignored, seen = [], [], set()
for extra in extras:
    if valid(extra) and extra["path"] not in seen:
        seen.add(extra["path"])
        pushed.append({"path": extra["path"], "status": "added", "content": extra["content"], "encoding": "utf-8"})
    else:
        ignored.append(listed(extra.get("path") if isinstance(extra, dict) else None))

kept = [f for f in agent_files if not (isinstance(f, dict) and f.get("path") in seen)]
if len(kept) + len(pushed) > MAX_FILES:
    ignored += [e["path"] for e in pushed]
    print(json.dumps({"files": agent_files, "ignored": ignored[:50]}))
else:
    print(json.dumps({"files": kept + pushed, "ignored": ignored[:50]}))
