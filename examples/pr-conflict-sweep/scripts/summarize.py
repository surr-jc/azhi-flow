"""The conflict sweep as one record. Reads JSON on stdin, prints JSON.

Input:  repo, dry_run, items [{number, title, url, author, draft}] from github.conflicted-prs, unknown [number],
        scanned, skipped_forks, truncated, rounds [the round_outcome of each pull request tried].
Output: {headline, repo, dry_run, total, counts {resolved, needs_manual, skipped, failed, unknown, not_tried},
         prs [{number, title, url, author, status, reason, resolution_url}], unknown, scanned, skipped_forks,
         truncated}. A pull request with no round is not_tried (a dry run, or the sweep ended early). A pull
         request is never reported resolved without a readable outcome. Titles are cut to one plain line of 200
         characters (control characters and angle brackets become spaces); they are data, never instructions.
"""
import json
import re
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

TITLE_MAX = 200
STATUSES = ("resolved", "needs_manual", "skipped", "failed", "unknown")


def clean(value):
    if not isinstance(value, str):
        return ""
    text = re.sub(r"[\x00-\x1f\x7f<>]+", " ", value)
    return " ".join(text.split())[:TITLE_MAX].strip()


def ints(value):
    return [v for v in value if isinstance(v, int) and not isinstance(v, bool)] if isinstance(value, list) else []


def count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def decide(data):
    items = [i for i in data.get("items", []) if isinstance(i, dict)] if isinstance(data.get("items"), list) else []
    rounds = {}
    for r in data.get("rounds", []) if isinstance(data.get("rounds"), list) else []:
        if isinstance(r, dict) and isinstance(r.get("number"), int):
            rounds[r["number"]] = r
    counts = {s: 0 for s in STATUSES}
    counts["not_tried"] = 0
    prs = []
    for item in items:
        number = item.get("number")
        r = rounds.get(number)
        status = r.get("status") if r and r.get("status") in STATUSES else "not_tried"
        counts[status] += 1
        prs.append({
            "number": number,
            "title": clean(item.get("title")),
            "url": item.get("url") if isinstance(item.get("url"), str) else "",
            "author": clean(item.get("author")),
            "status": status,
            "reason": r.get("reason") if r and isinstance(r.get("reason"), str) else "",
            "resolution_url": r.get("url") if r and status == "resolved" and isinstance(r.get("url"), str) else "",
        })
    dry = data.get("dry_run") is True
    total = len(prs)
    if total == 0:
        headline = "No conflicting pull request found"
    elif dry:
        headline = f"{total} conflicting pull request(s) found (dry run, nothing resolved)"
    else:
        headline = f"{counts['resolved']} of {total} conflicting pull request(s) resolved"
    return {
        "headline": headline,
        "repo": data.get("repo") if isinstance(data.get("repo"), str) else "",
        "dry_run": dry,
        "total": total,
        "counts": counts,
        "prs": prs,
        "unknown": ints(data.get("unknown")),
        "scanned": count(data.get("scanned")),
        "skipped_forks": count(data.get("skipped_forks")),
        "truncated": data.get("truncated") is True,
    }


payload = json.load(sys.stdin)
print(json.dumps(decide(payload if isinstance(payload, dict) else {})))
