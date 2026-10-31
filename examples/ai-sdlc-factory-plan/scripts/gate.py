"""Says whether there is an epic number `n` to split. Reads JSON on stdin {count, n}, prints {proceed}.

It exists only to join the GitHub and Jira branches of the epic before it: a condition cannot merge, a script can.
"""
import json
import sys

d = json.load(sys.stdin) or {}
print(json.dumps({"proceed": int(d.get("count") or 0) >= int(d.get("n") or 0)}))
