"""Passes on the build that ran. The workflow has a tested, a static-checks and an untested variant of the
build and of the fix round, and exactly one of each runs; the steps after them read this one output."""
import json
import sys

data = json.load(sys.stdin)
change = data.get("tested") or data.get("static") or data.get("untested")
if not change:
    raise SystemExit("no build variant produced a change")
print(json.dumps(change))
