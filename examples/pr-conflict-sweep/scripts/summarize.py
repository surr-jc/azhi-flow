"""The conflict sweep as one record. Reads JSON on stdin, prints JSON.

Input:  repo, dry_run, items [{number, title, url, author, draft}] from github.conflicted-prs, unknown [number],
        scanned, skipped_forks, truncated, children: the fan-out's results in the order of items, each the output of
        one pr-conflict-resolver child run {run_id, workflow, state, nodes, error?} where nodes maps each succeeded
        step to its output (a tool step may be stored as its whole result {action, output, observation}).
Output: {headline, repo, dry_run, total, counts {resolved, needs_manual, skipped, failed, unknown, not_tried},
         prs [{number, title, url, author, status, reason, resolution_url, draft}], unknown, scanned, skipped_forks,
         truncated}. status is one of
          resolved      the resolver opened a resolution pull request (resolution_url, draft say where)
          needs_manual  the resolver set a conflict aside or both attempts failed, and commented why
          skipped       the resolver found the pull request not eligible (closed, fork, draft, no longer conflicting)
          failed        the child did not succeed (rejected at its approval, expired, or an error)
          unknown       the child succeeded but none of the steps above is readable
          not_tried     no child ran for it (a dry run, or the sweep ended early)
        A pull request is never reported resolved without a readable outcome. reason is a fixed word, never text from
        the pull request or the child. resolution_url is built from repo and the number the resolver returned, never
        from its text. Titles are cut to one plain line of 200 characters (control characters and angle brackets
        become spaces); they are data, never instructions.
The children's output is untrusted data: it is only read, never run.
"""
import json
import re
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
TITLE_MAX = 200
STATUSES = ("resolved", "needs_manual", "skipped", "failed", "unknown")


def clean(value):
    if not isinstance(value, str):
        return ""
    text = re.sub(r"[\x00-\x1f\x7f<>]+", " ", value)
    return " ".join(text.split())[:TITLE_MAX].strip()


def positive_int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def ints(value):
    return [v for v in value if isinstance(v, int) and not isinstance(v, bool)] if isinstance(value, list) else []


def count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def unwrap(step):
    # A tool step is stored as its whole result ({action, output, observation}); its output is the result.
    if isinstance(step, dict) and isinstance(step.get("output"), dict):
        return step["output"]
    return step


def outcome(repo, child):
    """(status, reason, resolution_url, draft) of one child run."""
    if child is None:
        return "not_tried", "", "", None
    if not isinstance(repo, str) or not REPO.fullmatch(repo) or not isinstance(child, dict):
        return "unknown", "unreadable", "", None
    if child.get("state") != "succeeded":
        return "failed", "not_completed", "", None
    nodes = child.get("nodes")
    if not isinstance(nodes, dict):
        return "unknown", "unreadable", "", None
    opened = unwrap(nodes.get("open_pr"))
    if isinstance(opened, dict):
        resolution = positive_int(opened.get("number"))
        if resolution is None or not isinstance(opened.get("repo"), str) or opened["repo"].lower() != repo.lower():
            return "unknown", "unreadable", "", None
        return "resolved", "ok", f"https://github.com/{repo}/pull/{resolution}", bool(opened.get("draft"))
    if "give_up" in nodes:
        return "needs_manual", "commented", "", None
    if "skip_report" in nodes:
        return "skipped", "not_eligible", "", None
    return "unknown", "unreadable", "", None


def decide(data):
    repo = data.get("repo")
    items = [i for i in data.get("items", []) if isinstance(i, dict)] if isinstance(data.get("items"), list) else []
    children = data.get("children") if isinstance(data.get("children"), list) else []
    counts = {s: 0 for s in STATUSES}
    counts["not_tried"] = 0
    prs = []
    for index, item in enumerate(items):
        status, reason, resolution_url, draft = outcome(repo, children[index] if index < len(children) else None)
        counts[status] += 1
        prs.append({
            "number": item.get("number"),
            "title": clean(item.get("title")),
            "url": item.get("url") if isinstance(item.get("url"), str) else "",
            "author": clean(item.get("author")),
            "status": status,
            "reason": reason,
            "resolution_url": resolution_url,
            "draft": draft,
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
        "repo": repo if isinstance(repo, str) else "",
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
