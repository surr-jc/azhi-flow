"""Authoritative weekly quality numbers. Reads {runs, flaky, incidents} on stdin, prints JSON.

The current week is the 7 days ending at the newest run; the previous week is the 7 days
before that. Only runs on the main branch count.
"""
import json
import sys
from datetime import datetime, timedelta

data = json.load(sys.stdin) or {}
runs = [r for r in data.get("runs") or [] if r.get("branch", "main") == "main" and r.get("finished_at")]
flaky = data.get("flaky") or []
incidents = data.get("incidents") or []


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def week(rs):
    rs = sorted(rs, key=lambda r: ts(r["finished_at"]))
    total = len(rs)
    passed = sum(1 for r in rs if r["status"] == "success")
    failed = [r for r in rs if r["status"] != "success"]
    flaky_names = {f["test"] for f in flaky}
    flaky_failures = sum(1 for r in failed if set(r.get("failed_tests") or []) & flaky_names)
    # Mean time to green: from the first failure of a red streak to the next success.
    streaks, red_since = [], None
    for r in rs:
        if r["status"] != "success" and red_since is None:
            red_since = ts(r["finished_at"])
        elif r["status"] == "success" and red_since is not None:
            streaks.append((ts(r["finished_at"]) - red_since).total_seconds() / 3600)
            red_since = None
    return {
        "runs": total,
        "passed": passed,
        "pass_rate_pct": round(100 * passed / total, 1) if total else None,
        "flake_rate_pct": round(100 * flaky_failures / len(failed), 1) if failed else (0.0 if total else None),
        "mttg_hours": round(sum(streaks) / len(streaks), 2) if streaks else None,
    }


def delta(a, b):
    return round(a - b, 2) if a is not None and b is not None else None


end = max((ts(r["finished_at"]) for r in runs), default=None)
if end is None:
    cur, prev, window = week([]), week([]), {}
else:
    start, prev_start = end - timedelta(days=7), end - timedelta(days=14)
    cur = week([r for r in runs if ts(r["finished_at"]) > start])
    prev = week([r for r in runs if prev_start < ts(r["finished_at"]) <= start])
    window = {"start": start.isoformat(), "end": end.isoformat()}

print(json.dumps({
    "window": window,
    **cur,
    "pass_rate_delta_pct": delta(cur["pass_rate_pct"], prev["pass_rate_pct"]),
    "flake_rate_delta_pct": delta(cur["flake_rate_pct"], prev["flake_rate_pct"]),
    "mttg_delta_hours": delta(cur["mttg_hours"], prev["mttg_hours"]),
    "flaky_tests": len(flaky),
    "quarantined": sum(1 for f in flaky if f.get("quarantined")),
    "open_incidents": len(incidents),
}))
