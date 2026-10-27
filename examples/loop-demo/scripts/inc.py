"""One loop iteration: reads {"n": ...} on stdin, prints {"n": n + 1}."""
import json
import sys

print(json.dumps({"n": json.load(sys.stdin)["n"] + 1}))
