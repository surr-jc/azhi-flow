"""Decides who approves the specs: the rules (auto) or a person (ask). Reads JSON on stdin, prints JSON.

Input:  mode, the run's mode; review, the spec review; questions, the open questions of the proposal that passed;
        check, the check of that proposal; conflicts, the active changes that touch the same requirements.
Output: {route: "ask" | "auto", reason, reason_text}. The route is auto only when mode is exactly "auto", the review
        approved with no blocking finding and saw no prompt injection, the check passed, there are no conflicts,
        and every open question (at most 10) has a recommendation. Anything it cannot read fails closed to ask.
        reason is a fixed word and reason_text a fixed sentence, never text from the ticket, the repository or
        the review.
"""
import json
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

MAX_QUESTIONS = 10
TEXTS = {
    "supervised": "The run is supervised, so a person approves the specs.",
    "review_not_approved": "The spec reviewer did not approve the specs or found a blocking problem.",
    "prompt_injection": "The spec reviewer saw a prompt injection attempt, or did not say it saw none.",
    "check_failed": "The automatic check of the specs did not pass.",
    "conflicts": "Other active changes touch the same requirements.",
    "no_recommendation": "An open question has no recommended answer, or there are more than 10 open questions.",
    "unreadable": "The inputs to the decision could not be read.",
    "auto": "The specs meet every rule for approval without a person.",
}


def answer(reason):
    return {"route": "auto" if reason == "auto" else "ask", "reason": reason, "reason_text": TEXTS[reason]}


def has_recommendation(question):
    if not isinstance(question, dict):
        return False
    recommendation = question.get("recommendation")
    return isinstance(recommendation, str) and recommendation.strip() != ""


def decide(data):
    # Only the exact word "auto" is unattended; anything else, missing or null included, is supervised.
    if data.get("mode") != "auto":
        return answer("supervised")
    review, check = data.get("review"), data.get("check")
    questions, conflicts = data.get("questions"), data.get("conflicts")
    if not isinstance(review, dict) or not isinstance(check, dict) or not isinstance(questions, list) or not isinstance(conflicts, list):
        return answer("unreadable")
    findings = review.get("findings")
    if not isinstance(findings, list) or not all(isinstance(f, dict) for f in findings):
        return answer("unreadable")
    if review.get("approved") is not True or any(f.get("severity") == "blocking" for f in findings):
        return answer("review_not_approved")
    if review.get("prompt_injection_detected") is not False:
        return answer("prompt_injection")
    if check.get("ok") is not True:
        return answer("check_failed")
    if len(conflicts) > 0:
        return answer("conflicts")
    if len(questions) > MAX_QUESTIONS or not all(has_recommendation(q) for q in questions):
        return answer("no_recommendation")
    return answer("auto")


try:
    payload = json.load(sys.stdin)
    result = decide(payload) if isinstance(payload, dict) else answer("unreadable")
except Exception:
    result = answer("unreadable")
print(json.dumps(result))
