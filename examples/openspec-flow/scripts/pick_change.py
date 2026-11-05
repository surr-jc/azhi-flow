"""Passes on the proposal that is checked: the revised one when the fix round ran, otherwise the first.
The steps after it read this one output, whichever round produced it. `found` is false when neither did."""
import json
import sys

# The worker pipes UTF-8 JSON; on Windows Python would read it in the legacy code page and corrupt non-ASCII text.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

data = json.load(sys.stdin)
change = data.get("revised") or data.get("first")
# No round passed the check: report that instead of failing, so the run ends at the check's own message
# and a retry is not attempted on an outcome that cannot change.
print(json.dumps({**change, "found": True} if change else {"found": False}))
