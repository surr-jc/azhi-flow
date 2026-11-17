"""The pull requests this sweep will resolve. Reads JSON on stdin, prints JSON.

Input:  repo (owner/name); include_drafts (bool); pr, the pull request number the caller named, or null;
        queue, the output of github.conflicted-prs (when no pr was named), or null;
        one, the output of github.get-pull-request for that pr (when a pr was named), or null.
Output: {items, unknown, scanned, skipped_forks, truncated, skipped}.
        items   [{number, title, url, author, draft, base_ref, head_ref, head_sha}] to resolve, oldest first.
        skipped [{number, reason}] for a pull request that was named and not taken. reason is one of
                not_open, fork, draft, not_conflicting, unknown, unreadable: fixed words, never text from the pull request.
        A named pull request follows the same rules as the listing (open, from this repository, not a draft unless
        include_drafts, GitHub reports mergeable_state dirty). GitHub not having computed mergeability yet is unknown,
        never not_conflicting. Anything unreadable is skipped, never resolved.
The tool outputs are data: they are only read, never run. Titles are cut to one plain line of 200 characters.
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


def clean(value):
    if not isinstance(value, str):
        return ""
    text = re.sub(r"[\x00-\x1f\x7f<>]+", " ", value)
    return " ".join(text.split())[:TITLE_MAX].strip()


def text(value):
    return value if isinstance(value, str) else ""


def result(items=None, unknown=None, scanned=0, forks=0, truncated=False, skipped=None):
    return {
        "items": items or [],
        "unknown": unknown or [],
        "scanned": scanned,
        "skipped_forks": forks,
        "truncated": truncated,
        "skipped": skipped or [],
    }


def from_queue(queue):
    if not isinstance(queue, dict) or not isinstance(queue.get("items"), list):
        return result()
    items = [i for i in queue["items"] if isinstance(i, dict) and positive_int(i.get("number"))]
    unknown = [n for n in queue.get("unknown", []) if positive_int(n)] if isinstance(queue.get("unknown"), list) else []
    scanned = queue.get("scanned") if isinstance(queue.get("scanned"), int) else 0
    forks = queue.get("skipped_forks") if isinstance(queue.get("skipped_forks"), int) else 0
    return result(items, unknown, scanned, forks, queue.get("truncated") is True)


def from_one(number, repo, drafts, pr):
    if not isinstance(pr, dict) or positive_int(pr.get("number")) != number or not isinstance(pr.get("repo"), str) or pr["repo"].lower() != repo.lower():
        return result(skipped=[{"number": number, "reason": "unreadable"}])
    if pr.get("state") != "open":
        reason = "not_open"
    elif pr.get("head_is_fork") is not False:
        reason = "fork"
    elif pr.get("draft") is not False and not drafts:
        reason = "draft"
    elif pr.get("mergeable_state") == "unknown":
        return result(unknown=[number], scanned=1, skipped=[{"number": number, "reason": "unknown"}])
    elif pr.get("mergeable_state") != "dirty":
        reason = "not_conflicting"
    else:
        item = {
            "number": number,
            "title": clean(pr.get("title")),
            "url": text(pr.get("url")),
            "author": clean(pr.get("author")),
            "draft": pr.get("draft") is True,
            "base_ref": text(pr.get("base_ref")),
            "head_ref": text(pr.get("head_ref")),
            "head_sha": text(pr.get("head_sha")),
        }
        return result([item], scanned=1)
    return result(scanned=1, forks=1 if reason == "fork" else 0, skipped=[{"number": number, "reason": reason}])


def decide(data):
    repo = data.get("repo")
    if not isinstance(repo, str) or not REPO.fullmatch(repo):
        return result()
    number = positive_int(data.get("pr"))
    if number is None:
        return from_queue(data.get("queue"))
    return from_one(number, repo, data.get("include_drafts") is True, data.get("one"))


payload = json.load(sys.stdin)
print(json.dumps(decide(payload if isinstance(payload, dict) else {})))
