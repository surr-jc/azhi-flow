"""The breakdown as a Markdown file for the first Story's pull request. Reads JSON on stdin, prints JSON.

Input:  source ("github" or "files"), release (the release id), prd (the release plan as Markdown), order (the output of
        the order step {ok, stories: [{ref, number, title, epic, inputs}]}).
Output: {files: [{path, content}]}. Empty for github, and for files when the order cannot be read or has no Story. For
        files one file, docs/release/<release>/breakdown.md: a title, a line saying Azhi Flow's sdd-factory wrote it for
        review in this pull request and that the Stories below are delivered in this order as stacked pull requests,
        the plan (cut to 30000 characters) and the Stories ("### <key>: <title>", the epic, the body cut to 3000
        characters). The whole file is at most 60000 characters: the plan is cut first, and the Story bodies only when
        the plan is gone and they still do not fit.
Titles, bodies and the plan are untrusted text from agents. They are cleaned of control characters and appear only
inside this document, never in a path or a command.
"""
import json
import re
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

KEY = re.compile(r"^[a-z0-9][a-z0-9-]{0,60}$")
MAX_TOTAL = 60000
PLAN_MAX = 30000
BODY_MAX = 3000
MARK = "\n\n[cut]"


def clean_text(value):
    # Newlines and tabs stay; every other control character goes.
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", value) if isinstance(value, str) else ""


def clean_title(value):
    if not isinstance(value, str):
        return ""
    return " ".join(re.sub(r"[\x00-\x1f\x7f<>]+", " ", value).split())[:200].strip()


def cut(text, cap):
    if len(text) <= cap:
        return text
    if cap <= len(MARK):
        return text[: max(cap, 0)]
    return text[: cap - len(MARK)].rstrip() + MARK


def stories_of(order):
    out = []
    listed = order.get("stories") if isinstance(order, dict) else None
    if not isinstance(order, dict) or order.get("ok") is not True or not isinstance(listed, list):
        return None
    for s in listed:
        if not isinstance(s, dict):
            return None
        key, epic = s.get("ref"), s.get("epic")
        inputs = s.get("inputs")
        body = inputs.get("story_body") if isinstance(inputs, dict) else None
        if not isinstance(key, str) or not KEY.fullmatch(key) or not isinstance(epic, int) or isinstance(epic, bool):
            return None
        out.append((key, clean_title(s.get("title")), epic, clean_text(body)))
    return out


def build(release, plan, stories, plan_cap, body_cap):
    parts = [
        f"# Release breakdown: {release}",
        "Written by Azhi Flow's sdd-factory for review in this pull request. The Stories below are delivered in this order "
        "as stacked pull requests, each cut from the one before it; this file is committed in the first of them.",
        "## Release plan",
        cut(plan, plan_cap) if plan_cap > 0 else ("(no plan text)" if not plan.strip() else "(not shown: the breakdown is too long)"),
        "## Stories",
    ]
    for key, title, epic, body in stories:
        parts.append(f"### {key}: {title}\n\nEpic {epic}\n\n{cut(body, body_cap)}")
    return "\n\n".join(parts) + "\n"


def decide(data):
    release = data.get("release")
    stories = stories_of(data.get("order"))
    if data.get("source") != "files" or not isinstance(release, str) or not KEY.fullmatch(release) or not stories:
        return {"files": []}
    plan = clean_text(data.get("prd"))
    plan_cap = min(PLAN_MAX, len(plan))
    body_cap = min(BODY_MAX, max(len(s[3]) for s in stories))
    content = build(release, plan, stories, plan_cap, body_cap)
    # Cut the plan first; only when it is gone, shorten the Story bodies.
    for _ in range(40):
        over = len(content) - MAX_TOTAL
        if over <= 0:
            break
        if plan_cap > 0:
            plan_cap = max(0, plan_cap - over - len(MARK))
        else:
            body_cap = max(0, body_cap - (over // len(stories) + 1))
        content = build(release, plan, stories, plan_cap, body_cap)
    content = content[:MAX_TOTAL]
    return {"files": [{"path": f"docs/release/{release}/breakdown.md", "content": content}]}


payload = json.load(sys.stdin)
print(json.dumps(decide(payload if isinstance(payload, dict) else {})))
