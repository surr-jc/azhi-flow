"""Joins the two ways the pull request gets signed off: a person, or the rules. Reads JSON on stdin, prints JSON.

Input:  person, the signoff approval's output {decision, by} when a person was asked, otherwise null; auto, the
        output of signoff_auto when the rules decided, otherwise null.
Output: {decision, by}. decision is "approved" or "rejected" as the person or the rules said; anything else,
        including an input it cannot read, gives {decision: null, by: null}, which signs nothing off.
"""
import json
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

NONE = {"decision": None, "by": None}


def decide(data):
    person, auto = data.get("person"), data.get("auto")
    if isinstance(person, dict):
        by = person.get("by")
        if person.get("decision") in ("approved", "rejected") and isinstance(by, str) and by:
            return {"decision": person["decision"], "by": by}
        return NONE
    if isinstance(auto, dict) and auto.get("decision") == "approved" and auto.get("by") == "auto":
        return {"decision": "approved", "by": "auto"}
    return NONE


try:
    payload = json.load(sys.stdin)
    result = decide(payload) if isinstance(payload, dict) else NONE
except Exception:
    result = NONE
print(json.dumps(result))
