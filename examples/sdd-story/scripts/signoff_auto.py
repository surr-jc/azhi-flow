"""The sign-off taken by the rules, with no person asked. Reads JSON on stdin, prints JSON.

Input:  key, the ticket key; pr_url, the pull request URL; tests_status, review_status, fix_ran, remaining (the
        findings that remain, a list).
Output: {decision: "approved", by: "auto", slack}. slack is the text posted for the decision; it says plainly that
        nobody signed it off. The key and the URL come from the ticket and the pull request, so they are data:
        control characters and < > become spaces, whitespace is collapsed, each item is cut to 300 characters and
        the text to 3000. Unknown values read "unavailable".
"""
import json
import re
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

ITEM = 300
WHOLE = 3000


def clean(value, limit=ITEM):
    if not isinstance(value, str):
        return ""
    return " ".join(re.sub(r"[\x00-\x1f\x7f-\x9f<>]", " ", value).split())[:limit]


try:
    data = json.load(sys.stdin)
except Exception:
    data = {}
data = data if isinstance(data, dict) else {}
remaining = data.get("remaining")
count = str(len(remaining)) if isinstance(remaining, list) else "unavailable"
fix = "a fix round ran and its tests passed, but the fix was not reviewed again" if data.get("fix_ran") is True else "no fix round was needed"
slack = (
    f"Signed off by rules, nobody signed this off: {clean(data.get('key'), 100) or 'unavailable'}, "
    f"pull request {clean(data.get('pr_url'), 500) or 'unavailable'}. "
    f"Tests {clean(data.get('tests_status'), 40) or 'unavailable'}; review {clean(data.get('review_status'), 40) or 'unavailable'}; "
    f"{fix}; {count} follow-up finding(s) remain."
)
print(json.dumps({"decision": "approved", "by": "auto", "slack": slack[:WHOLE]}))
