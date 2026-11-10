"""The mode every Story runs in. Reads JSON on stdin, prints JSON.

Input:  data, the autonomy approval's decision data (may be null or empty).
Output: {mode: "supervised"}. Only supervised exists for now, so anything else the approval holds is clamped to it.
        This is the one place an unattended mode would be allowed through later.
"""
import json
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

MODES = ("supervised",)


def decide(data):
    asked = data.get("mode") if isinstance(data, dict) else None
    return {"mode": asked if asked in MODES else "supervised"}


payload = json.load(sys.stdin)
print(json.dumps(decide(payload.get("data") if isinstance(payload, dict) else None)))
