"""Passes on the proposal that is checked: the revised one when the fix round ran, otherwise the first.
The steps after it read this one output, whichever round produced it."""
import json
import sys

# The worker pipes UTF-8 JSON; on Windows Python would read it in the legacy code page and corrupt non-ASCII text.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

data = json.load(sys.stdin)
change = data.get("revised") or data.get("first")
if not change:
    raise SystemExit("no proposal round produced a change")
print(json.dumps(change))
