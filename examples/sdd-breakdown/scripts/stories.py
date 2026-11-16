"""The Stories this run returns to its parent: the output of the whole workflow.

Reads JSON on stdin: the final plan (null when the run stopped before it), whether the analyst said this is not
a code change, and the `epic` and `release` the run was started with. Writes
{status: ok | none | not_code, epic, release, stories: [{slice, title, body}]}.

Titles and bodies come from the epic text and the repository, which are untrusted, so they are cleaned here:
control characters other than newline and tab are removed, `<` and `>` become spaces in titles (titles reach
Slack), and lengths are cut. Anything that cannot be read fails the run (exit 1), never `none`: `none` means the person
left every slice out, and a parent that read an unreadable plan as `none` would deliver an incomplete release.
"""
import json
import re
import sys

MAX_STORIES, MAX_TITLE, MAX_BODY = 6, 200, 19000
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


def clip(s, n):
    return s if len(s) <= n else s[: n - 1] + "…"


def text(s):
    return CONTROL.sub("", s.replace("\r\n", "\n"))


def line(s, n):
    return clip(re.sub(r"\s+", " ", CONTROL.sub(" ", re.sub(r"[<>]", " ", s))).strip(), n)


def epic_of(v):
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 1 else None


def release_of(v):
    return v if isinstance(v, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,60}", v) else None


def build(d):
    epic, release = epic_of(d.get("epic")), release_of(d.get("release"))
    out = {"status": "none", "epic": epic, "release": release, "stories": []}
    plan = d.get("plan")
    if plan is None:
        # Only an explicit stop (the analyst said this is not a code change) is a result without a plan.
        if d.get("stopped") is not True:
            raise ValueError("no plan and no stop")
        out["status"] = "not_code"
        return out
    if plan["mode"] != "ok":
        return out
    title = line(plan.get("epic_title") or "", 120)
    head = (f"Part of epic {epic}" + (f": {title}" if title else "") + "\n\n") if epic is not None else ""
    for pos, s in enumerate(plan["stories"][:MAX_STORIES], 1):
        body = clip(text(head + s["body"]), MAX_BODY)
        out["stories"].append({"slice": pos, "title": line(s["title"], MAX_TITLE) or f"Story {pos}", "body": body})
    out["status"] = "ok" if out["stories"] else "none"
    return out


try:
    result = build(json.load(sys.stdin))
except Exception:
    # Not "none": a parent reads none as "this epic legitimately produced nothing" and goes on with the next epic, which
    # would silently deliver an incomplete release. Failing the run makes the parent stop.
    sys.stderr.write("stories: the plan could not be read\n")
    sys.exit(1)
print(json.dumps(result))
