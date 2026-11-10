"""The Stories to deliver, in order. Reads JSON on stdin, prints JSON.

Input:  split, the output of the split_epics loop {outcome, reason, count, exited, last, rounds} where rounds is a list
        of {round, outcome, reason, steps: {split_outcome: output or null}}; null when the loop did not run (no
        epics). epics, how many epics the plan has. repo, the repository the Stories live in (owner/name).
Output: {ok, problem, count, stories: [{ref, number, title, epic}], too_many}.
        stories are in delivery order: epics in plan order, then each epic's Stories in the order the splitter created
        them, de-duplicated by issue number. ok is false, with count 0 and no stories, when a split failed
        (problem "split_failed"), when anything cannot be read (problem "unreadable"), or when there are more than 20
        Stories (problem "too_many", too_many true; the delivery loop has 20 rounds, so nothing is delivered).
        No epics is ok with nothing to deliver. ref is rebuilt from the repo input and the issue number; a ref or a
        title in the input is never used to build one.
The input is untrusted data: it is only read, never run. Anything unreadable fails closed.
"""
import json
import re
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
TITLE_MAX = 200
MAX_STORIES = 20


def positive_int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def clean_title(value):
    if not isinstance(value, str):
        return None
    text = re.sub(r"[\x00-\x1f\x7f<>]+", " ", value)
    text = " ".join(text.split())[:TITLE_MAX].strip()
    return text or None


def result(ok, problem, stories, too_many=False, count=None):
    return {"ok": ok, "problem": problem, "count": len(stories) if count is None else count, "stories": stories, "too_many": too_many}


def closed(problem):
    return result(False, problem, [], count=0)


def decide(data):
    repo = data.get("repo")
    if not isinstance(repo, str) or not REPO.fullmatch(repo):
        return closed("unreadable")
    epics = data.get("epics")
    if epics is not None and (not isinstance(epics, int) or isinstance(epics, bool) or epics < 0):
        return closed("unreadable")
    split = data.get("split")
    if split is None:
        # The loop did not run: that is only right when the plan has no epic to split.
        return result(True, None, []) if epics == 0 else closed("unreadable")
    if not isinstance(split, dict):
        return closed("unreadable")
    rounds = split.get("rounds")
    if not isinstance(rounds, list) or not rounds:
        return closed("split_failed" if split.get("outcome") == "stop" else "unreadable")

    outcomes = []
    unreadable = False
    for r in rounds:
        steps = r.get("steps") if isinstance(r, dict) else None
        step = steps.get("split_outcome") if isinstance(steps, dict) else None
        if not isinstance(step, dict):
            unreadable = True
            continue
        outcomes.append(step)
    if split.get("outcome") == "stop" or any(o.get("status") != "ok" for o in outcomes):
        return closed("split_failed")
    if unreadable or split.get("outcome") != "done":
        return closed("unreadable")
    # Every epic must have been split: a loop that ended early without a failure is not a finished split.
    if epics is not None and len(outcomes) != epics:
        return closed("unreadable")

    stories = []
    seen = set()
    for o in outcomes:
        epic = positive_int(o.get("epic"))
        listed = o.get("stories")
        if epic is None or not isinstance(listed, list):
            return closed("unreadable")
        for s in listed:
            number = positive_int(s.get("number")) if isinstance(s, dict) else None
            if number is None:
                return closed("unreadable")
            if number in seen:
                continue
            seen.add(number)
            stories.append({"ref": f"{repo}#{number}", "number": number, "title": clean_title(s.get("title")), "epic": epic})
    if len(stories) > MAX_STORIES:
        return result(False, "too_many", [], too_many=True, count=len(stories))
    return result(True, None, stories)


payload = json.load(sys.stdin)
print(json.dumps(decide(payload if isinstance(payload, dict) else {})))
