"""Joins the two ways to the sign-off: the review approved (no fix round) or the fix round ran and its tests
passed. Reads JSON on stdin, prints JSON.

Input:  fix, the output of fix_done when the fix round ran, otherwise null.
Output: {fix_ran, fix}. Only the sign-off reads it, so it can name the round that ran without reading a step the
        other round skips.
"""
import json
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

data = json.load(sys.stdin) or {}
fix = data.get("fix") if isinstance(data.get("fix"), dict) else None
print(json.dumps({"fix_ran": fix is not None, "fix": fix}))
