"""Joins the two ways the specs get approved: a person, or the rules. Reads JSON on stdin, prints JSON.

Input:  person, the approval's output {decision, by, data} when a person was asked, otherwise null; auto, the
        output of specs_auto when the rules decided, otherwise null; questions, the open questions.
Output: {by, data: {notes}}. For a person, by is the approver and notes are theirs; when they left the notes empty
        and there are open questions, notes are the recommended answers, so the engineer always gets concrete
        answers. For auto, notes are specs_auto's. Only an approved decision counts: anything else gives
        {by: null, data: null}, which no write accepts.
"""
import json
import re
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

ITEM = 300
WHOLE = 3000
NONE = {"by": None, "data": None}


def clean(value, limit=ITEM):
    if not isinstance(value, str):
        return ""
    return " ".join(re.sub(r"[\x00-\x1f\x7f-\x9f<>]", " ", value).split())[:limit]


def recommended(questions):
    rows = []
    for q in questions if isinstance(questions, list) else []:
        if isinstance(q, dict) and clean(q.get("recommendation")):
            rows.append(f"{len(rows) + 1}. {clean(q.get('question'))} -> {clean(q.get('recommendation'))}")
    return ("Taken as recommended:\n" + "\n".join(rows))[:WHOLE] if rows else ""


def decide(data):
    person, auto = data.get("person"), data.get("auto")
    if isinstance(person, dict):
        by = person.get("by")
        if person.get("decision") != "approved" or not isinstance(by, str) or not by:
            return NONE
        body = person.get("data") if isinstance(person.get("data"), dict) else {}
        notes = body.get("notes") if isinstance(body.get("notes"), str) else ""
        return {"by": by, "data": {"notes": notes if notes.strip() else recommended(data.get("questions"))}}
    if isinstance(auto, dict) and auto.get("decision") == "approved" and auto.get("by") == "auto" and isinstance(auto.get("notes"), str):
        return {"by": "auto", "data": {"notes": auto["notes"]}}
    return NONE


try:
    payload = json.load(sys.stdin)
    result = decide(payload) if isinstance(payload, dict) else NONE
except Exception:
    result = NONE
print(json.dumps(result))
