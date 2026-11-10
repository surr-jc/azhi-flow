"""Decides who signs the pull request off: the rules (auto) or a person (ask). Reads JSON on stdin, prints JSON.

Input:  mode, the run's mode; tests, the build's test result; review, the review outcome; fix, the signoff_state
        output {fix_ran, fix}; verify, the verifier's report; spec_review, the spec review; pr, the pull request.
Output: {route: "ask" | "auto", reason, reason_text}. The route is auto only when mode is exactly "auto", the build's
        tests passed, the review itself approved, the verifier found no CRITICAL issue and saw no prompt
        injection, the spec reviewer saw none, the pull request is not a draft, and no remaining finding needs a
        hand check. A review that asked for changes is not approved by a fix round that passed its tests: nobody
        reviewed the fix, so a person signs it off (reason fix_not_reviewed). Anything it cannot read fails closed to ask. reason is a
        fixed word and reason_text a fixed sentence, never text from the ticket, the repository or the review.
"""
import json
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

TEXTS = {
    "supervised": "The run is supervised, so a person signs the pull request off.",
    "tests_not_passed": "The build's tests did not pass.",
    "review_not_clean": "The review did not approve the pull request.",
    "fix_not_reviewed": "The review asked for changes and a fix round followed; nobody reviewed the fix, so a person signs it off.",
    "critical_issue": "The verifier found a CRITICAL issue.",
    "prompt_injection": "The verifier or the spec reviewer saw a prompt injection attempt, or did not say it saw none.",
    "draft_pull_request": "The pull request is a draft.",
    "needs_hand_check": "A remaining review finding has to be checked by hand.",
    "unreadable": "The inputs to the decision could not be read.",
    "auto": "The pull request meets every rule for sign-off without a person.",
}


def answer(reason):
    return {"route": "auto" if reason == "auto" else "ask", "reason": reason, "reason_text": TEXTS[reason]}


def decide(data):
    # Only the exact word "auto" is unattended; anything else, missing or null included, is supervised.
    if data.get("mode") != "auto":
        return answer("supervised")
    tests, review, fix = data.get("tests"), data.get("review"), data.get("fix")
    verify, spec_review, pr = data.get("verify"), data.get("spec_review"), data.get("pr")
    if not all(isinstance(v, dict) for v in (review, verify, spec_review, pr)):
        return answer("unreadable")
    remaining, issues = review.get("remaining"), verify.get("issues")
    if not isinstance(remaining, list) or not all(isinstance(f, dict) for f in remaining):
        return answer("unreadable")
    if not isinstance(issues, list) or not all(isinstance(i, dict) for i in issues):
        return answer("unreadable")
    if not isinstance(tests, dict) or tests.get("status") != "passed":
        return answer("tests_not_passed")
    fix = fix if isinstance(fix, dict) else {}
    if review.get("status") != "approved":
        return answer("fix_not_reviewed" if fix.get("fix_ran") is True else "review_not_clean")
    if any(i.get("level") == "CRITICAL" for i in issues):
        return answer("critical_issue")
    if verify.get("prompt_injection_detected") is not False or spec_review.get("prompt_injection_detected") is not False:
        return answer("prompt_injection")
    if pr.get("draft") is not False:
        return answer("draft_pull_request")
    if any(f.get("triage") == "check_by_hand" for f in remaining):
        return answer("needs_hand_check")
    return answer("auto")


try:
    payload = json.load(sys.stdin)
    result = decide(payload) if isinstance(payload, dict) else answer("unreadable")
except Exception:
    result = answer("unreadable")
print(json.dumps(result))
