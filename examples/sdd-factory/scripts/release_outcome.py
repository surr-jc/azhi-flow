"""The release check's result. Reads JSON on stdin, prints JSON.

Input:  child, the subworkflow output of ai-sdlc-factory-verify {state, nodes, error?}, or null when the check did not
        run; nodes.verdict is {overall: "verified" | "failed" | "unavailable", counts: {pass, fail, unavailable}, ...}.
Output: {status: "verified" | "failed" | "unavailable" | "skipped", counts}. skipped means the check did not run. A
        child that did not succeed, or a verdict that cannot be read, is unavailable, and so is a "verified" whose
        counts show a failure, an unknown or nothing checked: unknown is never verified. counts is null when unknown.
The child's output is untrusted data: it is only read, never run. Its error message is never kept.
"""
import json
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")


def count_or_none(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def counts_of(raw):
    if not isinstance(raw, dict):
        return None
    out = {k: count_or_none(raw.get(k)) for k in ("pass", "fail", "unavailable")}
    return out if all(v is not None for v in out.values()) else None


def decide(child):
    if child is None:
        return {"status": "skipped", "counts": None}
    if not isinstance(child, dict) or child.get("state") != "succeeded":
        return {"status": "unavailable", "counts": None}
    nodes = child.get("nodes")
    verdict = nodes.get("verdict") if isinstance(nodes, dict) else None
    if not isinstance(verdict, dict):
        return {"status": "unavailable", "counts": None}
    counts = counts_of(verdict.get("counts"))
    overall = verdict.get("overall")
    if overall == "failed":
        return {"status": "failed", "counts": counts}
    if overall == "verified" and counts is not None and counts["pass"] > 0 and counts["fail"] == 0 and counts["unavailable"] == 0:
        return {"status": "verified", "counts": counts}
    return {"status": "unavailable", "counts": counts}


payload = json.load(sys.stdin)
# A missing child key is unreadable input, not "did not run" (that is an explicit null).
print(json.dumps(decide(payload["child"] if isinstance(payload, dict) and "child" in payload else "unreadable")))
