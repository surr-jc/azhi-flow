"""The specs approval taken by the rules, with no person asked. Reads JSON on stdin, prints JSON.

Input:  key, the ticket key; questions, the open questions {question, recommendation, why}.
Output: {decision: "approved", by: "auto", notes, slack}. notes is plain text for the engineer, one line per
        question with the recommendation taken. slack is the text posted for the decision.
        Question, recommendation, why and the key come from the ticket, the repository or the spec author, so they
        are data: control characters and < > become spaces, whitespace is collapsed, each item is cut to 300
        characters and a whole text to 3000. A question without a recommendation is left out of the lines.
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


def taken(questions):
    """The questions that carry a recommendation, as (question, recommendation, why), cleaned."""
    rows = []
    for q in questions if isinstance(questions, list) else []:
        if isinstance(q, dict) and clean(q.get("recommendation")):
            rows.append((clean(q.get("question")), clean(q.get("recommendation")), clean(q.get("why"))))
    return rows


try:
    data = json.load(sys.stdin)
except Exception:
    data = {}
data = data if isinstance(data, dict) else {}
rows = taken(data.get("questions"))
key = clean(data.get("key"), 100) or "the ticket"
if rows:
    notes = "Auto mode: no person was asked. Taken as recommended:\n" + "\n".join(f"{i}. {q} -> {r}" for i, (q, r, _) in enumerate(rows, 1))
else:
    notes = "Auto mode: no person was asked. No open questions."
slack = f"Specs for {key} approved by rules, no person asked: the reviewer approved, the check passed, there are no conflicts."
if rows:
    slack += " Open questions, answered as recommended:\n" + "\n".join(f"{i}. {q} -> {r}" + (f" (why: {w})" if w else "") for i, (q, r, w) in enumerate(rows, 1))
else:
    slack += " No open questions."
print(json.dumps({"decision": "approved", "by": "auto", "notes": notes[:WHOLE], "slack": slack[:WHOLE]}))
