"""Passes the review-path decision on as one record: proposed, final, and who overrode the proposal (or null)."""
import json
import sys

d = json.load(sys.stdin)
print(json.dumps({"proposed": d["proposed"], "final": d["final"], "overridden_by": d.get("overridden_by") or None}))
