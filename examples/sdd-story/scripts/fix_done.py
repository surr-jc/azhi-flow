"""What the fix round did, for the sign-off. Reads JSON on stdin, prints JSON.

Input:  fix, the fix agent's report {summary, fixed, skipped}; tests, the worker's test result for the fixed
        checkout {status, attempts}; pushed, the re-push {commit_sha};
        extra_files_ignored, the paths of the extra files the re-push left out (push_fix_files).
Output: {ran: true, summary, fixed, skipped, tests_status, tests_attempts, commit_sha, re_reviewed: false,
        extra_files_ignored}.
        The fix is tested, not re-reviewed; the sign-off says so. Unknown values are null.
"""
import json
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")


def text_or_none(value, limit):
    return value[:limit] if isinstance(value, str) and value else None


def texts(value, limit):
    return [v[:limit] for v in value if isinstance(v, str)][:25] if isinstance(value, list) else []


data = json.load(sys.stdin) or {}
fix = data.get("fix") if isinstance(data.get("fix"), dict) else {}
tests = data.get("tests") if isinstance(data.get("tests"), dict) else {}
pushed = data.get("pushed") if isinstance(data.get("pushed"), dict) else {}
attempts = tests.get("attempts")
print(json.dumps({
    "ran": True,
    "summary": text_or_none(fix.get("summary"), 300),
    "fixed": texts(fix.get("fixed"), 300),
    "skipped": texts(fix.get("skipped"), 300),
    "tests_status": text_or_none(tests.get("status"), 20),
    "tests_attempts": attempts if isinstance(attempts, int) and not isinstance(attempts, bool) else None,
    "commit_sha": text_or_none(pushed.get("commit_sha"), 64),
    "re_reviewed": False,
    "extra_files_ignored": texts(data.get("extra_files_ignored"), 200),
}))
