"""Whether one Story was signed off, and the branch it left. Reads JSON on stdin, prints JSON.

Input:  child, the subworkflow output of sdd-story {run_id, workflow, state, nodes, error?}; nodes.result is the
        Story's own result {status, reason, branch, head_sha, pr_number, pr_url}.
Output: {status: "signed_off" | "sent_back", reason, branch, pr_number, pr_url, last}. last is true unless the input says
        another Story follows (last false): the deliver_stories loop ends after the round whose last is true. signed_off only when the child
        succeeded, its result says signed_off, the branch is one of Azhi's (azhi/...) and the pull request number is
        a positive integer. Anything else is sent_back with a fixed reason word (story_failed, no_result, bad_branch,
        or the Story's own reason when it is one of the known words) and branch null. The next Story is stacked on
        this branch, so a Story is never stacked on a branch that was not signed off.
The child's output is untrusted data: it is only read, never run. Its error message can quote untrusted text, so it is
never kept.
"""
import json
import re
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

# The next Story takes this as its stack_on input (examples/sdd-story: [A-Za-z0-9._/-], at most 200), so a branch it would
# refuse is not one to stack on.
BRANCH = re.compile(r"azhi/[A-Za-z0-9._/-]+")
URL = re.compile(r"^https://[^\s]+$")
# The fixed reason words examples/sdd-story/scripts/result.py can give a Story that was sent back.
KNOWN = {
    "specs_rejected",
    "specs_invalid",
    "tests_failed",
    "archive_failed",
    "review_unavailable",
    "fix_tests_failed",
    "signoff_rejected",
    "not_signed_off",
}


def positive_int_or_none(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def url_or_none(value):
    return value if isinstance(value, str) and len(value) <= 500 and URL.fullmatch(value) else None


def sent_back(reason, pr_number=None, pr_url=None):
    return {"status": "sent_back", "reason": reason, "branch": None, "pr_number": pr_number, "pr_url": pr_url}


def decide(data):
    # The loop ends after this round unless the step that knows the Story count said there is another. Unknown ends it.
    last = data.get("last") is not False
    return {**decide_one(data), "last": last}


def decide_one(data):
    child = data.get("child")
    if not isinstance(child, dict) or child.get("state") != "succeeded":
        return sent_back("story_failed")
    nodes = child.get("nodes")
    result = nodes.get("result") if isinstance(nodes, dict) else None
    if not isinstance(result, dict):
        return sent_back("no_result")
    pr_number = positive_int_or_none(result.get("pr_number"))
    pr_url = url_or_none(result.get("pr_url"))
    status = result.get("status")
    if status == "signed_off":
        branch = result.get("branch")
        if not isinstance(branch, str) or len(branch) > 200 or not BRANCH.fullmatch(branch):
            return sent_back("bad_branch", pr_number, pr_url)
        if pr_number is None:
            return sent_back("no_result", None, pr_url)
        return {"status": "signed_off", "reason": "signed_off", "branch": branch, "pr_number": pr_number, "pr_url": pr_url}
    if status == "sent_back":
        reason = result.get("reason")
        return sent_back(reason if isinstance(reason, str) and reason in KNOWN else "not_signed_off", pr_number, pr_url)
    return sent_back("no_result")


payload = json.load(sys.stdin)
print(json.dumps(decide(payload if isinstance(payload, dict) else {})))
