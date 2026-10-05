"""Reads {"x": ...} on stdin, prints {"doubled": x * 2}."""
import json
import sys

print(json.dumps({"doubled": json.load(sys.stdin)["x"] * 2}))
