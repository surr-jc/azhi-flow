"""The Story's result, for a parent workflow to read. Reads JSON on stdin, prints JSON.

Input:  flags for the routes that ran (each is false when its route did not), signoff, the sign-off decision
        ("approved", "rejected" or null), and what the run produced (branch, head_sha, pr_number, pr_url; null when
        it does not exist).
Output: {status: "signed_off" | "sent_back", reason, branch, head_sha, pr_number, pr_url}. Only an approved
        sign-off on a run with a pull request is signed_off; anything else, including a missing or unreadable
        input, is sent_back. reason is a fixed word, never text from the ticket, the repository or the review.
"""
import json
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

# The first route that ran decides the reason; they cannot both run.
STOPS = (
    ("specs_rejected", "specs_rejected"),
    ("specs_invalid", "specs_invalid"),
    ("tests_failed", "tests_failed"),
    ("archive_failed", "archive_failed"),
    ("review_unavailable", "review_unavailable"),
    ("fix_tests_failed", "fix_tests_failed"),
)


def text_or_none(value, limit):
    return value[:limit] if isinstance(value, str) and value else None


def positive_int_or_none(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def decide(data):
    flags = data.get("flags") if isinstance(data.get("flags"), dict) else {}
    branch = text_or_none(data.get("branch"), 250)
    head_sha = text_or_none(data.get("head_sha"), 64)
    pr_number = positive_int_or_none(data.get("pr_number"))
    pr_url = text_or_none(data.get("pr_url"), 500)
    reason = None
    for key, word in STOPS:
        if flags.get(key) is True:
            reason = word
            break
    if reason is None:
        decision = data.get("signoff")
        if decision == "approved" and pr_number is not None and pr_url is not None:
            return {"status": "signed_off", "reason": "signed_off", "branch": branch, "head_sha": head_sha, "pr_number": pr_number, "pr_url": pr_url}
        reason = "signoff_rejected" if decision == "rejected" else "not_signed_off"
    return {"status": "sent_back", "reason": reason, "branch": branch, "head_sha": head_sha, "pr_number": pr_number, "pr_url": pr_url}


payload = json.load(sys.stdin)
print(json.dumps(decide(payload if isinstance(payload, dict) else {})))
