"""Names the parent every slice is linked under: the issue the run started from, or the umbrella it created.

Reads JSON on stdin: {issue (the input reference, empty for free text), created (the umbrella's create-issue
output, or null), repo}.
"""
import json
import re
import sys

d = json.load(sys.stdin)
created = d.get("created")
if created:
    out = {"number": int(created["number"]), "url": created.get("url", ""), "created": True}
else:
    m = re.search(r"(\d+)\D*$", d.get("issue") or "")
    if not m:
        raise SystemExit("no parent issue: neither an issue was given nor an umbrella created")
    out = {"number": int(m.group(1)), "url": f"https://github.com/{d['repo']}/issues/{m.group(1)}", "created": False}
print(json.dumps(out))
