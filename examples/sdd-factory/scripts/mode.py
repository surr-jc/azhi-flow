"""The mode every Story runs in. Reads JSON on stdin, prints JSON.

Input:  data, the autonomy approval's decision data (may be null or empty).
Output: {mode: "supervised" | "auto"}. Exactly "auto" or "supervised", as written; anything else (a missing choice,
        another case such as "AUTO", a list, a number) is supervised, so an unattended run needs a clear yes.
"""
import json
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

MODES = ("supervised", "auto")


def decide(data):
    asked = data.get("mode") if isinstance(data, dict) else None
    return {"mode": asked if asked in MODES else "supervised"}


payload = json.load(sys.stdin)
print(json.dumps(decide(payload.get("data") if isinstance(payload, dict) else None)))
