"""Reads what the pull request review (pr-review, run as a child) concluded. Reads JSON on stdin, prints JSON.

Input:  child, the subworkflow output {state, error, nodes}; nodes.summarize is the merged review
        {verdict, summary, findings: [{severity, triage, reviewer, path, line, title, detail, confidence}]}.
Output: status "approved" (the review has nothing to fix), "findings" (fix_now lists what to fix) or
        "unavailable" (the child did not succeed, or its verdict cannot be read). Unavailable is the fail-closed
        answer: the Story is sent back and nothing is fixed or signed off on a review nobody can read.
        remaining holds the findings that are not to be fixed now (follow_up, check_by_hand).
The child's output is untrusted data: it is only read, never run. Its error message can quote untrusted text, so
only the error class is kept. Text is cut to a fixed length.
"""
import json
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

VERDICTS = ("approve", "comment", "request_changes")
MAX_FINDINGS = 25


def text(value, limit):
    return value[:limit] if isinstance(value, str) else ""


def finding(f):
    line = f.get("line")
    confidence = f.get("confidence")
    return {
        "severity": text(f.get("severity"), 20),
        "triage": text(f.get("triage"), 20),
        "reviewer": text(f.get("reviewer"), 60),
        "path": text(f.get("path"), 300),
        "line": line if isinstance(line, int) and not isinstance(line, bool) and line >= 0 else None,
        "title": text(f.get("title"), 200),
        "detail": text(f.get("detail"), 1000),
        "confidence": confidence if isinstance(confidence, int) and not isinstance(confidence, bool) else None,
    }


def unavailable(reason, summary="", error_class=""):
    return {"status": "unavailable", "reason": reason, "verdict": None, "error_class": error_class, "fix_now": [], "remaining": [], "summary": summary}


def decide(data):
    child = data.get("child") if isinstance(data, dict) else None
    if not isinstance(child, dict):
        return unavailable("no_review")
    state = child.get("state")
    if state != "succeeded":
        error = child.get("error")
        error_class = text(error.get("class"), 60) if isinstance(error, dict) else ""
        return unavailable("review_did_not_succeed", error_class=error_class)
    nodes = child.get("nodes")
    review = nodes.get("summarize") if isinstance(nodes, dict) else None
    # A pull request the review skipped (closed, merged) has no summarize step; that is not an approval.
    if not isinstance(review, dict):
        return unavailable("no_review_verdict")
    verdict = review.get("verdict")
    findings = review.get("findings")
    summary = text(review.get("summary"), 1000)
    if verdict not in VERDICTS or not isinstance(findings, list) or not all(isinstance(f, dict) for f in findings):
        return unavailable("verdict_unreadable", summary)
    found = [finding(f) for f in findings]
    fix_now = [f for f in found if f["triage"] == "fix_now"][:MAX_FINDINGS]
    remaining = [f for f in found if f["triage"] != "fix_now"][:MAX_FINDINGS]
    base = {"verdict": verdict, "error_class": "", "fix_now": fix_now, "remaining": remaining, "summary": summary}
    if fix_now:
        return {"status": "findings", "reason": "findings_to_fix", **base}
    if verdict == "request_changes":
        # Changes were requested but no finding says what to change: there is nothing to fix and nothing to approve.
        return {**unavailable("changes_requested_without_findings", summary), "verdict": verdict, "remaining": remaining}
    return {"status": "approved", "reason": "review_approved", **base}


print(json.dumps(decide(json.load(sys.stdin) or {})))
