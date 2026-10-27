"""Passes on the build that ran. The workflow has a tested, a static-checks and an untested variant of the
build and of the fix round, and exactly one of each runs; the steps after them read this one output."""
import json
import sys

# The worker pipes UTF-8 JSON; on Windows Python would read it in the legacy code page and corrupt non-ASCII text.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

data = json.load(sys.stdin)
change = data.get("tested") or data.get("static") or data.get("untested")
if not change:
    raise SystemExit("no build variant produced a change")
print(json.dumps(change))
