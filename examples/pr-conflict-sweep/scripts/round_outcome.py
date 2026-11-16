"""What one pr-conflict-resolver run did to its pull request. Reads JSON on stdin, prints JSON.

Input:  child, the subworkflow output {run_id, workflow, state, nodes, error?} where nodes maps each succeeded step to
        its output (a tool step may be stored as its whole result {action, output, observation}); repo (owner/name);
        number, the pull request; last, false when another pull request follows this one.
Output: {status, number, url, draft, reason, last}. status is one of
          resolved      the resolver opened a resolution pull request (url, draft say where)
          needs_manual  the resolver set a conflict aside or both attempts failed, and commented why
          skipped       the resolver found the pull request not eligible (closed, fork, draft, no longer conflicting)
          failed        the child did not succeed (rejected at its approval, expired, or an error)
          unknown       the child succeeded but none of the steps above is readable
        reason is a fixed word, never text from the pull request or the child. url is built from repo and the number
        the resolver returned, never from its text. The loop ends after the round whose last is true; unknown ends it.
The child's output is untrusted data: it is only read, never run.
"""
import json
import re
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def positive_int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def out(number, status, reason, url=None, draft=None):
    return {"status": status, "number": number, "url": url, "draft": draft, "reason": reason}


def unwrap(step):
    # A tool step is stored as its whole result ({action, output, observation}); its output is the result.
    if isinstance(step, dict) and "output" in step and isinstance(step["output"], dict):
        return step["output"]
    return step


def decide_one(data):
    repo = data.get("repo")
    number = positive_int(data.get("number"))
    if not isinstance(repo, str) or not REPO.fullmatch(repo) or number is None:
        return out(number, "unknown", "unreadable")
    child = data.get("child")
    if not isinstance(child, dict):
        return out(number, "unknown", "unreadable")
    if child.get("state") != "succeeded":
        return out(number, "failed", "not_completed")
    nodes = child.get("nodes")
    if not isinstance(nodes, dict):
        return out(number, "unknown", "unreadable")

    opened = unwrap(nodes.get("open_pr"))
    if isinstance(opened, dict):
        resolution = positive_int(opened.get("number"))
        if resolution is None or not isinstance(opened.get("repo"), str) or opened["repo"].lower() != repo.lower():
            return out(number, "unknown", "unreadable")
        url = f"https://github.com/{repo}/pull/{resolution}"
        return out(number, "resolved", "ok", url, bool(opened.get("draft")))
    if "give_up" in nodes:
        return out(number, "needs_manual", "commented")
    if "skip_report" in nodes:
        return out(number, "skipped", "not_eligible")
    return out(number, "unknown", "unreadable")


def decide(data):
    # The loop ends after this round unless the step that knows the list length said there is another. Unknown ends it.
    last = data.get("last") is not False
    return {**decide_one(data), "last": last}


payload = json.load(sys.stdin)
print(json.dumps(decide(payload if isinstance(payload, dict) else {})))
