"""The Stories to deliver, in order. Reads JSON on stdin, prints JSON.

Input:  source, "github" or "files" (absent means github). split, the output of the split_epics loop, and breakdown,
        the output of the breakdown_epics loop, each {outcome, reason, count, exited, last, rounds} where rounds is a
        list of {round, outcome, reason, steps: {split_outcome | breakdown_outcome: output or null}}; null when that
        loop did not run (the other source, or no epics). epics, how many epics the plan has. repo, the repository the
        Stories live in (owner/name). release, the release id (files only).
Output: {ok, problem, count, stories: [{ref, number, title, epic, inputs}], too_many}.
        inputs is {ticket, story_key, story_title, story_body}, all strings: what the sdd-story child receives.
        github: stories are in delivery order, epics in plan order, then each epic's Stories in the order the splitter
        created them, de-duplicated by issue number. ref is rebuilt from the repo input and the issue number; a ref or
        a title in the input is never used to build one. inputs is {ticket: ref, "", "", ""}.
        files: the same, from the breakdown: epics in plan order, then each epic's Stories by slice, numbered 1..N
        across the whole release. number is N, ref and story_key are "<release>-s<N>", title is the cleaned title and
        story_body the body. ticket is "".
        ok is false, with count 0 and no stories, when a split or breakdown failed (problem "split_failed"), when
        anything cannot be read (problem "unreadable"), or when there are more than 20 Stories (problem "too_many",
        too_many true; the delivery loop has 20 rounds, so nothing is delivered).
        No epics is ok with nothing to deliver.
The input is untrusted data: it is only read, never run. Anything unreadable fails closed.
"""
import json
import re
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
KEY = re.compile(r"^[a-z0-9][a-z0-9-]{0,60}$")
TITLE_MAX = 200
BODY_MAX = 19000
MAX_STORIES = 20


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


def result(ok, problem, stories, too_many=False, count=None):
    return {"ok": ok, "problem": problem, "count": len(stories) if count is None else count, "stories": stories, "too_many": too_many}


def closed(problem):
    return result(False, problem, [], count=0)


def outcomes_of(loop, step_name, epics):
    """The per-round outcomes of a loop, or a closed result (a dict with "ok") when they cannot be trusted."""
    if not isinstance(loop, dict):
        return closed("unreadable")
    rounds = loop.get("rounds")
    if not isinstance(rounds, list) or not rounds:
        return closed("split_failed" if loop.get("outcome") == "stop" else "unreadable")
    outcomes = []
    unreadable = False
    for r in rounds:
        steps = r.get("steps") if isinstance(r, dict) else None
        step = steps.get(step_name) if isinstance(steps, dict) else None
        if not isinstance(step, dict):
            unreadable = True
            continue
        outcomes.append(step)
    if loop.get("outcome") == "stop" or any(o.get("status") != "ok" for o in outcomes):
        return closed("split_failed")
    if unreadable or loop.get("outcome") != "done":
        return closed("unreadable")
    # Every epic must have been handled: a loop that ended early without a failure is not a finished split.
    if epics is not None and len(outcomes) != epics:
        return closed("unreadable")
    return outcomes


def github_stories(outcomes, repo):
    stories = []
    seen = set()
    for o in outcomes:
        epic = positive_int(o.get("epic"))
        listed = o.get("stories")
        if epic is None or not isinstance(listed, list):
            return None
        for s in listed:
            number = positive_int(s.get("number")) if isinstance(s, dict) else None
            if number is None:
                return None
            if number in seen:
                continue
            seen.add(number)
            ref = f"{repo}#{number}"
            stories.append({"ref": ref, "number": number, "title": clean_title(s.get("title")), "epic": epic, "inputs": {"ticket": ref, "story_key": "", "story_title": "", "story_body": ""}})
    return stories


def files_stories(outcomes, release):
    stories = []
    for o in outcomes:
        epic = positive_int(o.get("epic"))
        listed = o.get("stories")
        if epic is None or not isinstance(listed, list):
            return None
        rows = []
        for s in listed:
            slice_no = positive_int(s.get("slice")) if isinstance(s, dict) else None
            title = clean_title(s.get("title")) if isinstance(s, dict) else None
            body = clean_body(s.get("body")) if isinstance(s, dict) else None
            if slice_no is None or title is None or body is None:
                return None
            rows.append((slice_no, title, body))
        # Slice order inside the epic (a stable sort: the breakdown's own order breaks a tie).
        for _, title, body in sorted(rows, key=lambda r: r[0]):
            number = len(stories) + 1
            key = f"{release}-s{number}"
            if not KEY.fullmatch(key):
                return None
            stories.append({"ref": key, "number": number, "title": title, "epic": epic, "inputs": {"ticket": "", "story_key": key, "story_title": title, "story_body": body}})
    return stories


def decide(data):
    source = data.get("source")
    if source is None:
        source = "github"
    if source not in ("github", "files"):
        return closed("unreadable")
    repo = data.get("repo")
    if not isinstance(repo, str) or not REPO.fullmatch(repo):
        return closed("unreadable")
    release = data.get("release")
    if source == "files" and (not isinstance(release, str) or not KEY.fullmatch(release)):
        return closed("unreadable")
    epics = data.get("epics")
    if epics is not None and (not isinstance(epics, int) or isinstance(epics, bool) or epics < 0):
        return closed("unreadable")
    loop = data.get("split") if source == "github" else data.get("breakdown")
    if loop is None:
        # The loop did not run: that is only right when the plan has no epic to split.
        return result(True, None, []) if epics == 0 else closed("unreadable")
    outcomes = outcomes_of(loop, "split_outcome" if source == "github" else "breakdown_outcome", epics)
    if isinstance(outcomes, dict):
        return outcomes
    stories = github_stories(outcomes, repo) if source == "github" else files_stories(outcomes, release)
    if stories is None:
        return closed("unreadable")
    if len(stories) > MAX_STORIES:
        return result(False, "too_many", [], too_many=True, count=len(stories))
    return result(True, None, stories)


payload = json.load(sys.stdin)
print(json.dumps(decide(payload if isinstance(payload, dict) else {})))
