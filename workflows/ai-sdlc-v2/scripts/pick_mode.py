"""Says how this change can be verified: "tested" (the full test command passed on the base), "static"
(typecheck and build passed instead) or "untested" (neither could run and a person chose to continue).
Exactly one of the three preflight outcomes ran, so exactly one input is true."""
import json
import sys

data = json.load(sys.stdin)
if data.get("untested"):
    mode = "untested"
elif data.get("static"):
    mode = "static"
elif data.get("ok"):
    mode = "tested"
else:
    raise SystemExit("no preflight outcome")
print(json.dumps({"mode": mode}))
