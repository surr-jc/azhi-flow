"""The Stories one issue-splitter run created for an epic. Reads JSON on stdin, prints JSON.

Input:  last (false when another epic follows this one), child, the subworkflow output {run_id, workflow, state, nodes, error?} where nodes maps each succeeded step to
        its output (tool steps unwrapped); repo, the repository the Stories live in (owner/name); epic, the epic's
        number in the plan.
Output: {status: "ok" | "failed", epic, stories: [{ref, number, title}], reason, last}. last is true unless the input says
        another epic follows (last false): the split_epics loop ends after the round whose last is true. The stories are the sub-issues of a
        split (nodes.outcome.created) and, when the epic fit one pull request and the splitter created a single issue,
        that issue (nodes.single_create, a tool step: its issue is in the step's "output"). A splitter that created nothing, because every slice was left out at its
        approval, is ok with an empty list. A child that did not succeed, or whose nodes cannot be read, is failed
        with no stories.
        ref is built from the repo input and the issue number only, never from a title. Titles are cut to 200
        characters. reason is a fixed word, never text from the ticket or the child.
The child's output is untrusted data: it is only read, never run.
"""
import json
import re
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
TITLE_MAX = 200


def positive_int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def clean_title(value):
    # One plain line: control characters and angle brackets (Slack mentions) become spaces.
    if not isinstance(value, str):
        return None
    text = re.sub(r"[\x00-\x1f\x7f<>]+", " ", value)
    text = " ".join(text.split())[:TITLE_MAX].strip()
    return text or None


def failed(epic, reason):
    return {"status": "failed", "epic": epic, "stories": [], "reason": reason}


def decide(data):
    # The loop ends after this round unless the step that knows the epic count said there is another. Unknown ends it.
    last = data.get("last") is not False
    out = decide_one(data)
    return {**out, "last": last}


def decide_one(data):
    repo = data.get("repo")
    epic = positive_int(data.get("epic"))
    if not isinstance(repo, str) or not REPO.fullmatch(repo) or epic is None:
        return failed(epic, "unreadable")
    child = data.get("child")
    if not isinstance(child, dict):
        return failed(epic, "unreadable")
    if child.get("state") != "succeeded":
        return failed(epic, "split_failed")
    nodes = child.get("nodes")
    if not isinstance(nodes, dict):
        return failed(epic, "unreadable")

    found = []
    outcome = nodes.get("outcome")
    if outcome is not None:
        created = outcome.get("created") if isinstance(outcome, dict) else None
        if not isinstance(created, list):
            return failed(epic, "unreadable")
        found.extend(created)
    single = nodes.get("single_create")
    if single is not None:
        if not isinstance(single, dict):
            return failed(epic, "unreadable")
        # A tool step is stored as its whole result ({action, output, observation}); the issue is its output.
        if "output" in single:
            single = single["output"]
            if not isinstance(single, dict):
                return failed(epic, "unreadable")
        # A single issue must be in the repository being planned.
        if "repo" in single and (not isinstance(single["repo"], str) or single["repo"].lower() != repo.lower()):
            return failed(epic, "unreadable")
        found.append(single)
    if outcome is None and single is None:
        # Neither route of the splitter produced anything we can read: its result is unknown, not "nothing".
        return failed(epic, "unreadable")

    stories = []
    seen = set()
    for item in found:
        if not isinstance(item, dict):
            return failed(epic, "unreadable")
        number = positive_int(item.get("number"))
        if number is None:
            return failed(epic, "unreadable")
        if number in seen:
            continue
        seen.add(number)
        stories.append({"ref": f"{repo}#{number}", "number": number, "title": clean_title(item.get("title"))})
    return {"status": "ok", "epic": epic, "stories": stories, "reason": "ok" if stories else "none_created"}


payload = json.load(sys.stdin)
print(json.dumps(decide(payload if isinstance(payload, dict) else {})))
