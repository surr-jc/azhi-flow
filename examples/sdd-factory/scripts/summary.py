"""What the factory run did. Reads JSON on stdin, prints JSON.

Input:  prd_title (the plan's title, or null), order (the output of the order step, or null when the run ended before
        it), autonomy (the autonomy approval's decision, "approved" or "rejected", or null), mode, loop (the output of
        the deliver_stories loop {outcome, rounds: [{round, steps: {story_outcome}}]}, or null when it did not run),
        release (the release_outcome step's output, or null when it did not run).
Output: {status: "delivered" | "stopped" | "nothing_to_deliver" | "not_started", headline, prd_title, stories, stack,
        signed_off, total, stopped_at, release}.
        stories lists every Story in order with its result: signed_off, sent_back (with a fixed reason word) or
        not_started. stack is the signed-off Stories in order, which is the order to merge their pull requests in.
        stopped_at names where the run stopped: the first Story that was not signed off (as owner/name#N), or a
        fixed word (plan, split_failed, too_many, unreadable, autonomy); null when everything was delivered.
        release is {status, counts}; it is skipped unless every Story was signed off.
Everything is read as data. Ticket text, review text and error messages are never copied in: a Story's title (from the
splitter's issue, untrusted) is cut to 200 characters and kept as a title only, and every other text is a fixed word.
"""
import json
import re
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

TITLE_MAX = 200
URL = re.compile(r"^https://[^\s]+$")
BRANCH = re.compile(r"^azhi/[A-Za-z0-9._/#-]+$")
REF = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]+$")
REASONS = {
    "specs_rejected",
    "specs_invalid",
    "tests_failed",
    "archive_failed",
    "review_unavailable",
    "fix_tests_failed",
    "signoff_rejected",
    "not_signed_off",
    "story_failed",
    "no_result",
    "bad_branch",
}
RELEASE = ("verified", "failed", "unavailable", "skipped")
PROBLEM_HEADLINES = {
    "split_failed": "An epic could not be split; nothing was delivered.",
    "too_many": "The plan created more than 20 Stories, more than one run delivers; nothing was delivered. Split the release in two.",
    "unreadable": "The Stories could not be read; nothing was delivered.",
}


def positive_int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def clean_title(value):
    if not isinstance(value, str):
        return None
    text = re.sub(r"[\x00-\x1f\x7f<>]+", " ", value)
    text = " ".join(text.split())[:TITLE_MAX].strip()
    return text or None


def release_of(value, missing):
    if value is None:
        return {"status": missing, "counts": None}
    status = value.get("status") if isinstance(value, dict) else None
    if status not in RELEASE:
        return {"status": "unavailable", "counts": None}
    counts = value.get("counts")
    ok = isinstance(counts, dict) and all(isinstance(counts.get(k), int) and not isinstance(counts.get(k), bool) and counts[k] >= 0 for k in ("pass", "fail", "unavailable"))
    return {"status": status, "counts": {k: counts[k] for k in ("pass", "fail", "unavailable")} if ok else None}


def story_list(order):
    out = []
    for s in order.get("stories") if isinstance(order.get("stories"), list) else []:
        number = positive_int(s.get("number")) if isinstance(s, dict) else None
        ref = s.get("ref") if isinstance(s, dict) else None
        if number is None or not isinstance(ref, str) or not REF.fullmatch(ref) or not ref.endswith(f"#{number}"):
            return None
        out.append({"ref": ref, "number": number, "title": clean_title(s.get("title"))})
    return out


def result_of(loop, round_no):
    rounds = loop.get("rounds") if isinstance(loop.get("rounds"), list) else []
    for r in rounds:
        if isinstance(r, dict) and r.get("round") == round_no:
            steps = r.get("steps")
            step = steps.get("story_outcome") if isinstance(steps, dict) else None
            return step if isinstance(step, dict) else None
    return None


def base(status, headline, prd_title, stopped_at, release, rows=(), stack=()):
    signed = sum(1 for r in rows if r["status"] == "signed_off")
    return {
        "status": status,
        "headline": headline,
        "prd_title": prd_title,
        "stories": list(rows),
        "stack": list(stack),
        "signed_off": signed,
        "total": len(rows),
        "stopped_at": stopped_at,
        "release": release,
    }


def decide(d):
    prd_title = clean_title(d.get("prd_title"))
    skipped = {"status": "skipped", "counts": None}
    order = d.get("order")
    if not isinstance(order, dict):
        return base("not_started", "The run ended before the Stories were ordered; nothing was delivered.", prd_title, "plan", skipped)
    if order.get("ok") is not True:
        problem = order.get("problem") if order.get("problem") in PROBLEM_HEADLINES else "unreadable"
        return base("stopped", PROBLEM_HEADLINES[problem], prd_title, problem, skipped)
    stories = story_list(order)
    if stories is None:
        return base("stopped", PROBLEM_HEADLINES["unreadable"], prd_title, "unreadable", skipped)
    if not stories:
        return base("nothing_to_deliver", "The plan has no Story to deliver.", prd_title, None, skipped)

    pending = [dict(s, status="not_started", reason=None, pr_url=None, branch=None) for s in stories]
    loop = d.get("loop")
    if not isinstance(loop, dict):
        word = "Delivery was not approved" if d.get("autonomy") == "rejected" else "Delivery did not start"
        return base("not_started", f"{word}; no Story was delivered.", prd_title, "autonomy", skipped, pending)

    rows = []
    for i, s in enumerate(stories):
        got = result_of(loop, i + 1)
        row = dict(pending[i])
        if got is not None and got.get("status") == "signed_off":
            branch, url = got.get("branch"), got.get("pr_url")
            if isinstance(branch, str) and BRANCH.fullmatch(branch):
                row.update(status="signed_off", branch=branch, pr_url=url if isinstance(url, str) and len(url) <= 500 and URL.fullmatch(url) else None)
            else:
                row.update(status="sent_back", reason="bad_branch")
        elif got is not None and got.get("status") == "sent_back":
            reason = got.get("reason")
            url = got.get("pr_url")
            row.update(status="sent_back", reason=reason if reason in REASONS else "not_signed_off", pr_url=url if isinstance(url, str) and len(url) <= 500 and URL.fullmatch(url) else None)
        rows.append(row)

    stack = [{"number": r["number"], "title": r["title"], "pr_url": r["pr_url"], "branch": r["branch"]} for r in rows if r["status"] == "signed_off"]
    total = len(rows)
    signed = len(stack)
    if loop.get("outcome") == "done" and signed == total:
        release = release_of(d.get("release"), "unavailable")
        return base("delivered", f"Delivered {total} of {total} Stories; release check {release['status']}.", prd_title, None, release, rows, stack)
    first = next((r for r in rows if r["status"] == "sent_back"), None)
    if first is None:
        return base("stopped", f"Stopped after {signed} of {total} Stories; the delivery result could not be read.", prd_title, "unreadable", skipped, rows, stack)
    ref = next(s["ref"] for s in stories if s["number"] == first["number"])
    return base("stopped", f"Stopped at {ref} ({first['reason']}): {signed} of {total} Stories signed off.", prd_title, ref, skipped, rows, stack)


payload = json.load(sys.stdin)
print(json.dumps(decide(payload if isinstance(payload, dict) else {})))
