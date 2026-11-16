"""The Slack message that lists the Stories.

Reads JSON on stdin: the `stories` output and the slice numbers the approver left out. Titles are cleaned again
here, because they come from the epic text and the repository and reach Slack.
"""
import json
import re
import sys

d = json.load(sys.stdin)
s = d["stories"]
title = lambda t: re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f<>]", " ", t)).strip()[:200]
epic = f"epic {s['epic']}" if s.get("epic") else "the epic"
rel = f" (release {s['release']})" if s.get("release") else ""
if s["status"] == "ok" and s["stories"]:
    msg = f"Broke down {epic}{rel} into {len(s['stories'])} Story(ies), in delivery order:\n" + "\n".join(f"• {x['slice']}. {title(x['title'])}" for x in s["stories"])
else:
    msg = f"Nothing to deliver for {epic}{rel}: every slice was left out at the approval."
if d.get("dropped"):
    msg += f"\nLeft out at the approval: slice {', '.join(str(int(i)) for i in d['dropped'])}."
print(json.dumps({"message": msg[:3000]}))
