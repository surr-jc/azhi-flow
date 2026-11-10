"""The Stories one sdd-breakdown run returned for an epic. Reads JSON on stdin, prints JSON.

Input:  last (false when another epic follows this one), child, the subworkflow output of sdd-breakdown {run_id,
        workflow, state, nodes, error?} where nodes maps each succeeded step to its output (a script step is bare);
        epic, the epic's number in the plan.
Output: {status: "ok" | "failed", epic, stories: [{slice, title, body}], reason, last}. last is true unless the input
        says another epic follows (last false): the breakdown_epics loop ends after the round whose last is true.
        The stories are read from nodes.stories {status: "ok" | "none" | "not_code", stories}: none and not_code are
        ok with no Stories (nothing to deliver for that epic). A child that did not succeed (a rejected plan approval
        leaves no stories step), a node that is not an object, an unknown status, more than 6 Stories, a Story whose
        slice is not a positive integer, whose title is empty once cleaned or whose body is not a non-empty string,
        and anything else unreadable, is failed with no Stories.
        A title is one plain line (control characters and angle brackets become spaces, whitespace collapsed, cut to
        200 characters). A body keeps its newlines and tabs, loses other control characters and is cut to 19000
        characters. reason is a fixed word, never text from the epic or the child.
The child's output is untrusted data: it is only read, never run. Its error message is never kept.
"""
import json
import re
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

TITLE_MAX = 200
BODY_MAX = 19000
MAX_STORIES = 6


def positive_int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def clean_title(value):
    if not isinstance(value, str):
        return None
    text = re.sub(r"[\x00-\x1f\x7f<>]+", " ", value)
    text = " ".join(text.split())[:TITLE_MAX].strip()
    return text or None


def clean_body(value):
    if not isinstance(value, str):
        return None
    text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", value)[:BODY_MAX]
    return text if text.strip() else None


def failed(epic, reason):
    return {"status": "failed", "epic": epic, "stories": [], "reason": reason}


def decide(data):
    # The loop ends after this round unless the step that knows the epic count said there is another. Unknown ends it.
    last = data.get("last") is not False
    return {**decide_one(data), "last": last}


def decide_one(data):
    epic = positive_int(data.get("epic"))
    if epic is None:
        return failed(None, "unreadable")
    child = data.get("child")
    if not isinstance(child, dict):
        return failed(epic, "unreadable")
    if child.get("state") != "succeeded":
        return failed(epic, "breakdown_failed")
    nodes = child.get("nodes")
    node = nodes.get("stories") if isinstance(nodes, dict) else None
    if not isinstance(node, dict):
        # A rejected plan approval leaves no stories step; so does a child that could not be read.
        return failed(epic, "no_stories_step")
    status = node.get("status")
    if status == "none":
        return {"status": "ok", "epic": epic, "stories": [], "reason": "none_created"}
    if status == "not_code":
        return {"status": "ok", "epic": epic, "stories": [], "reason": "not_code"}
    if status != "ok":
        return failed(epic, "unreadable")
    listed = node.get("stories")
    if not isinstance(listed, list) or not listed or len(listed) > MAX_STORIES:
        return failed(epic, "bad_story")

    stories = []
    for item in listed:
        if not isinstance(item, dict):
            return failed(epic, "bad_story")
        slice_no = positive_int(item.get("slice"))
        title = clean_title(item.get("title"))
        body = clean_body(item.get("body"))
        if slice_no is None or title is None or body is None:
            return failed(epic, "bad_story")
        stories.append({"slice": slice_no, "title": title, "body": body})
    return {"status": "ok", "epic": epic, "stories": stories, "reason": "ok"}


payload = json.load(sys.stdin)
print(json.dumps(decide(payload if isinstance(payload, dict) else {})))
