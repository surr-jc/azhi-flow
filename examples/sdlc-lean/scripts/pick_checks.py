"""Collects the verifier's checks for the steps after it. The verifier runs only when the reviewer reported a critical or major finding,
so on a clean review it is skipped and there are no checks."""
import json
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

data = json.load(sys.stdin)
verify = data.get("verify") or {}
print(json.dumps({"checks": verify.get("checks") or []}))
